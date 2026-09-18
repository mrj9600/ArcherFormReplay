import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { Router } from '@angular/router';
import Peer, { DataConnection } from 'peerjs';
import { SettingsService } from './settings.service';
import { decodeTimestamp, encodeTimestamp, epochNow } from './time';
import {
  ArmMessage,
  ClipAckMessage,
  ClipMessage,
  DeviceState,
  DeviceStateMessage,
  MASTER_TRIGGER_ID,
  ROOM_ID_PREFIX,
  RemoteTriggerMessage,
  SessionEndedMessage,
  SessionMessage,
  SyncPingMessage,
  SyncPongMessage,
  TriggerAssignmentMessage,
  TriggerMessage,
  WelcomeMessage,
  generateRoomCode,
  isSessionMessage,
} from './session-protocol';

export type SessionRole = 'none' | 'master' | 'slave';
export type SessionConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

export interface ConnectedSlave {
  id: string;
  connectedAt: number;
}

export interface IncomingClip {
  slaveId: string;
  blob: Blob;
  triggerSeq: number;
}

export interface LocalTriggerEvent {
  /** Trigger time converted to this device's own epoch clock. */
  localTs: number;
  masterTs: number;
  triggerSeq: number;
  preRollSeconds: number;
  postRollSeconds: number;
}

export interface CollectionResult {
  clips: Map<string, Blob>;
  /** Slaves that were expected but never delivered a clip for this trigger. */
  missingIds: string[];
}

interface SyncSample {
  roundTripMs: number;
  offsetMs: number;
}

const SYNC_BURST_COUNT = 8;
const SYNC_BURST_INTERVAL_MS = 150;
const SYNC_INTERVAL_MS = 10_000;
const SYNC_SAMPLES_KEPT = 12;
const MAX_ROOM_CODE_ATTEMPTS = 5;
/** Collecting slave clips gives up on a device only after this long with no sign of life from
 *  it (a state update, a clip, ...) - a slow trim or upload on a busy phone is not a failure. */
const COLLECT_INACTIVITY_MS = 45_000;
const COLLECT_HARD_CAP_MS = 180_000;
/** How long after a trigger a slave has to show any sign of life before it's written off. */
const FIRST_RESPONSE_MS = 8_000;

/**
 * Owns the PeerJS connection(s) for a pairing session and speaks the small JSON+binary
 * protocol in session-protocol.ts. One device is "master" (creates the room, coordinates
 * clip collection); others join as "slave" and send their clip back. Either the master or
 * any connected slave can be assigned as the "trigger device" - the one whose microphone
 * actually detects the release - independent of who's hosting the session.
 *
 * Slaves record only while the master is on its Record page ("armed"), report what they're
 * doing (waiting, capturing, clipping, sending) so the master knows when to expect their clips,
 * and go idle after delivering one until the master re-arms them. All times on the wire are epoch
 * milliseconds (time.ts) - each slave converts to its own clock using the offset it measures
 * against the master.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly settingsService = inject(SettingsService);
  private readonly router = inject(Router);

  readonly role = signal<SessionRole>('none');
  readonly roomCode = signal<string | null>(null);
  readonly connectionState = signal<SessionConnectionState>('idle');
  readonly error = signal<string | null>(null);
  readonly connectedSlaves = signal<ConnectedSlave[]>([]);
  /** Slave only: true once at least one clock-sync round trip has completed. */
  readonly isSynced = signal(false);
  /** Master only: the latest state each connected slave reported, by slave id. */
  readonly slaveStates = signal<Record<string, DeviceState>>({});
  /** Master: whether the master is currently on Record and ready for a shot. Slave: whether the
   *  master has armed this device - it should be recording only while this is true. */
  readonly armed = signal(false);
  /** Master only: live progress while waiting for slave clips after a trigger. */
  readonly collectionProgress = signal<{ received: number; expected: number } | null>(null);
  /** This device's own PeerJS id, once known. */
  readonly selfId = signal<string | null>(null);
  /** MASTER_TRIGGER_ID, or a connected slave's id - whichever device's mic drives detection. */
  readonly triggerDeviceId = signal<string>(MASTER_TRIGGER_ID);
  /** Master only: whether the master device itself captures a video clip. */
  readonly masterRecordsVideo = signal(true);

  /** True if THIS device is the one currently assigned to detect the release. */
  readonly isTriggerDevice = computed(() => {
    switch (this.role()) {
      case 'none':
        return true;
      case 'master':
        return this.triggerDeviceId() === MASTER_TRIGGER_ID;
      case 'slave':
        return this.triggerDeviceId() === this.selfId();
    }
  });

  /** Slave only: fires when the master triggers, with the trigger time on this device's own clock. */
  readonly localTrigger$ = new Subject<LocalTriggerEvent>();
  /** Master only: fires as each slave's clip arrives. */
  readonly clipReceived$ = new Subject<IncomingClip>();
  /** Master only: fires when the assigned trigger device is a slave reporting a detected release. */
  readonly remoteTriggerRequested$ = new Subject<number>();
  /** Slave only: fires when the master confirms it received the clip for this trigger. */
  readonly clipAcknowledged$ = new Subject<number>();
  /** Master only: any sign of life from a slave (a state change or a clip). */
  private readonly slaveActivity$ = new Subject<{ slaveId: string; state?: DeviceState; triggerSeq?: number }>();
  private readonly slaveLeft$ = new Subject<string>();

  private peer: Peer | null = null;
  private masterConn: DataConnection | null = null;
  private readonly slaveConns = new Map<string, DataConnection>();
  /** Slave only: estimated (masterClock - thisDeviceClock) at the same real-world instant. */
  private clockOffsetMs = 0;
  private syncSamples: SyncSample[] = [];
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncBurstTimer: ReturnType<typeof setInterval> | null = null;
  /** Master only: monotonically increasing id handed out with each broadcast trigger. */
  private nextTriggerSeq = 1;

  constructor() {
    // Keeps every connected slave's settings (pre/post-roll, chunk size) in step with the
    // master's, including changes made after a slave has already joined.
    effect(() => {
      const settings = this.settingsService.settings();
      if (this.role() !== 'master') return;
      const message: WelcomeMessage = { type: 'welcome', settings };
      this.sendToAllSlaves(message);
    });

    // Keeps every slave informed of which device is currently assigned to detect the release.
    effect(() => {
      const triggerDeviceId = this.triggerDeviceId();
      if (this.role() !== 'master') return;
      const message: TriggerAssignmentMessage = { type: 'trigger-assignment', triggerDeviceId };
      this.sendToAllSlaves(message);
    });
  }

  async startMaster(): Promise<string> {
    this.teardown();
    this.role.set('master');
    this.connectionState.set('connecting');
    return this.tryStartMaster(MAX_ROOM_CODE_ATTEMPTS);
  }

  /** A 4-digit PIN only has 10,000 possible values, so a collision with someone else's active
   *  session on the shared public broker is plausible - unlike the old longer code, worth a few
   *  automatic retries with a fresh PIN before surfacing an error. */
  private tryStartMaster(attemptsLeft: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const code = generateRoomCode();
      const peer = new Peer(`${ROOM_ID_PREFIX}${code}`);
      this.peer = peer;

      peer.on('open', (id) => {
        this.selfId.set(id);
        this.roomCode.set(code);
        this.connectionState.set('connected');
        resolve(code);
      });
      peer.on('connection', (conn) => this.acceptSlaveConnection(conn));
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && attemptsLeft > 1) {
          peer.destroy();
          this.tryStartMaster(attemptsLeft - 1).then(resolve, reject);
          return;
        }
        this.error.set(err.message);
        this.connectionState.set('error');
        reject(err);
      });
    });
  }

  async joinAsSlave(rawCode: string): Promise<void> {
    this.teardown();
    this.role.set('slave');
    this.connectionState.set('connecting');
    const code = rawCode.replace(/\D/g, '');

    return new Promise((resolve, reject) => {
      const peer = new Peer();
      this.peer = peer;

      peer.on('open', (id) => {
        this.selfId.set(id);
        const conn = peer.connect(`${ROOM_ID_PREFIX}${code}`, { reliable: true });
        this.masterConn = conn;

        conn.on('open', () => {
          this.roomCode.set(code);
          this.connectionState.set('connected');
          this.startSyncLoop();
          resolve();
        });
        conn.on('data', (data) => this.handleSlaveIncomingData(data));
        conn.on('close', () => {
          this.connectionState.set('idle');
        });
        conn.on('error', (err) => {
          this.error.set(err.message);
          this.connectionState.set('error');
          reject(err);
        });
      });
      peer.on('error', (err) => {
        this.error.set(err.message);
        this.connectionState.set('error');
        reject(err);
      });
    });
  }

  leaveSession(): void {
    this.teardown();
    this.role.set('none');
    this.roomCode.set(null);
    this.connectionState.set('idle');
    this.error.set(null);
    this.connectedSlaves.set([]);
  }

  /** Master only: tells every connected slave the session is ending before tearing down locally
   *  - otherwise a slave would be left sitting on Record/Review waiting for a master that's gone. */
  async stopSession(): Promise<void> {
    if (this.role() === 'master') {
      const message: SessionEndedMessage = { type: 'session-ended' };
      this.sendToAllSlaves(message);
      // Give the data channel a moment to actually flush the message before the connections
      // it's flowing over get torn down.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.leaveSession();
  }

  /** Master only: assign which device's microphone should detect the release. */
  setTriggerDevice(deviceId: string): void {
    this.triggerDeviceId.set(deviceId);
  }

  /** Master only: toggle whether the master device itself captures a video clip. */
  setMasterRecordsVideo(recordsVideo: boolean): void {
    this.masterRecordsVideo.set(recordsVideo);
  }

  /** Master only: tell every slave the master is (or is no longer) ready for a shot - slaves
   *  start recording on true and stop on false. Also re-sent to any slave that joins later. */
  setArmed(armed: boolean): void {
    if (this.role() !== 'master') return;
    this.armed.set(armed);
    const message: ArmMessage = { type: 'arm', armed };
    this.sendToAllSlaves(message);
  }

  /** Slave only: this device has taken its shot - stay idle until the master arms it again. */
  consumeArm(): void {
    this.armed.set(false);
  }

  /** Slave only: tell the master what this device is doing now. */
  reportDeviceState(state: DeviceState, triggerSeq?: number): void {
    if (!this.masterConn?.open) return;
    const message: DeviceStateMessage = { type: 'device-state', state, triggerSeq };
    this.masterConn.send(message);
  }

  /** Master only: broadcast a trigger (alongside extracting your own local clip, if recording). Returns the sequence id to pass to collectClips. */
  broadcastTrigger(masterTs: number, preRollSeconds: number, postRollSeconds: number): number {
    const triggerSeq = this.nextTriggerSeq++;
    const message: TriggerMessage = {
      type: 'trigger',
      triggerSeq,
      masterTs: encodeTimestamp(masterTs),
      preRollSeconds,
      postRollSeconds,
    };
    this.sendToAllSlaves(message);
    return triggerSeq;
  }

  /** Slave only, when assigned as the trigger device: tell master a release was just detected/requested. */
  reportLocalTrigger(localTs: number): void {
    if (!this.masterConn?.open) return;
    const message: RemoteTriggerMessage = {
      type: 'remote-trigger',
      estimatedMasterTs: encodeTimestamp(localTs + this.clockOffsetMs),
    };
    this.masterConn.send(message);
  }

  /** Slave only: send this device's clip back to master for a given trigger. */
  sendClip(blob: Blob, mimeType: string, triggerSeq: number): void {
    if (!this.masterConn?.open) return;
    const message: ClipMessage = { type: 'clip', triggerSeq, mimeType, data: blob };
    this.masterConn.send(message);
  }

  /**
   * Master only: waits for a clip from every currently-connected slave for this trigger. Slaves
   * report their progress (capturing, clipping, sending), so instead of one fixed deadline this
   * gives up on a device only after it has been silent for a long while, or when it says it has
   * nothing to send, or disconnects. Resolves early once every expected clip has arrived.
   */
  collectClips(triggerSeq: number): Promise<CollectionResult> {
    const expectedIds = [...this.slaveConns.keys()];
    return new Promise((resolve) => {
      const clips = new Map<string, Blob>();
      if (expectedIds.length === 0) {
        resolve({ clips, missingIds: [] });
        return;
      }
      const outstanding = new Set(expectedIds);
      const responded = new Set<string>();
      const publishProgress = () =>
        this.collectionProgress.set({ received: clips.size, expected: clips.size + outstanding.size });
      publishProgress();

      let done = false;
      let inactivityTimer: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(inactivityTimer);
        clearTimeout(hardCapTimer);
        clearTimeout(firstResponseTimer);
        subscriptions.forEach((s) => s.unsubscribe());
        this.collectionProgress.set(null);
        resolve({ clips, missingIds: [...outstanding] });
      };
      const settle = (slaveId: string) => {
        outstanding.delete(slaveId);
        publishProgress();
        if (outstanding.size === 0) finish();
      };
      const resetInactivity = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(finish, COLLECT_INACTIVITY_MS);
      };

      const subscriptions = [
        this.clipReceived$.subscribe((clip) => {
          if (clip.triggerSeq !== triggerSeq || !outstanding.has(clip.slaveId)) return;
          clips.set(clip.slaveId, clip.blob);
          settle(clip.slaveId);
        }),
        this.slaveActivity$.subscribe(({ slaveId, state, triggerSeq: replySeq }) => {
          if (!outstanding.has(slaveId)) return;
          responded.add(slaveId);
          resetInactivity();
          // "Idle" in reply to this very trigger = the slave wasn't recording, so no clip is coming.
          if ((state === 'idle' || state === 'error') && replySeq === triggerSeq) {
            outstanding.delete(slaveId);
            publishProgress();
            if (outstanding.size === 0) finish();
          }
        }),
        this.slaveLeft$.subscribe((slaveId) => {
          if (!outstanding.has(slaveId)) return;
          outstanding.delete(slaveId);
          publishProgress();
          if (outstanding.size === 0) finish();
        }),
      ];
      resetInactivity();
      const hardCapTimer = setTimeout(finish, COLLECT_HARD_CAP_MS);
      // A working slave switches to "capturing" the instant it gets the trigger, so one that says
      // nothing at all shortly afterwards is gone (asleep, out of range, a connection that hasn't
      // noticed it dropped yet) - waiting out the full inactivity limit for it would stall every
      // shot behind a device that isn't coming back.
      const firstResponseTimer = setTimeout(() => {
        for (const id of [...outstanding]) {
          if (!responded.has(id)) outstanding.delete(id);
        }
        publishProgress();
        if (outstanding.size === 0) finish();
      }, FIRST_RESPONSE_MS);
    });
  }

  private sendToAllSlaves(message: SessionMessage): void {
    for (const conn of this.slaveConns.values()) {
      if (conn.open) conn.send(message);
    }
  }

  private acceptSlaveConnection(conn: DataConnection): void {
    conn.on('open', () => {
      this.slaveConns.set(conn.peer, conn);
      this.connectedSlaves.set([...this.connectedSlaves(), { id: conn.peer, connectedAt: Date.now() }]);
      this.slaveStates.set({ ...this.slaveStates(), [conn.peer]: 'idle' });
      const welcome: WelcomeMessage = { type: 'welcome', settings: this.settingsService.settings() };
      conn.send(welcome);
      const assignment: TriggerAssignmentMessage = { type: 'trigger-assignment', triggerDeviceId: this.triggerDeviceId() };
      conn.send(assignment);
      if (this.armed()) {
        const arm: ArmMessage = { type: 'arm', armed: true };
        conn.send(arm);
      }
    });
    conn.on('data', (data) => this.handleMasterIncomingData(conn, data));
    conn.on('close', () => this.removeSlave(conn.peer));
    conn.on('error', () => this.removeSlave(conn.peer));
  }

  private removeSlave(id: string): void {
    this.slaveConns.delete(id);
    this.connectedSlaves.set(this.connectedSlaves().filter((s) => s.id !== id));
    const { [id]: _removed, ...remainingStates } = this.slaveStates();
    this.slaveStates.set(remainingStates);
    this.slaveLeft$.next(id);
    // The assigned trigger device just left - fall back to the master so the session stays usable.
    if (this.triggerDeviceId() === id) {
      this.triggerDeviceId.set(MASTER_TRIGGER_ID);
    }
  }

  private handleMasterIncomingData(conn: DataConnection, data: unknown): void {
    if (!isSessionMessage(data)) return;

    if (data.type === 'sync-ping') {
      const pong: SyncPongMessage = { type: 'sync-pong', sentAt: data.sentAt, receivedAt: encodeTimestamp(epochNow()) };
      conn.send(pong);
    } else if (data.type === 'clip') {
      const raw = data.data;
      const blob = raw instanceof Blob ? raw : new Blob([raw], { type: data.mimeType });
      // Acked even if the master has already stopped waiting for it, so the slave can go idle.
      const ack: ClipAckMessage = { type: 'clip-ack', triggerSeq: data.triggerSeq };
      conn.send(ack);
      this.slaveActivity$.next({ slaveId: conn.peer });
      this.clipReceived$.next({ slaveId: conn.peer, blob, triggerSeq: data.triggerSeq });
    } else if (data.type === 'remote-trigger') {
      this.remoteTriggerRequested$.next(decodeTimestamp(data.estimatedMasterTs));
    } else if (data.type === 'device-state') {
      this.slaveStates.set({ ...this.slaveStates(), [conn.peer]: data.state });
      this.slaveActivity$.next({ slaveId: conn.peer, state: data.state, triggerSeq: data.triggerSeq });
    }
  }

  private handleSlaveIncomingData(data: unknown): void {
    if (!isSessionMessage(data)) return;

    switch (data.type) {
      case 'welcome':
        this.settingsService.update(data.settings);
        break;
      case 'trigger-assignment':
        this.triggerDeviceId.set(data.triggerDeviceId);
        break;
      case 'sync-pong':
        this.applySyncSample(data);
        break;
      case 'arm':
        this.armed.set(data.armed);
        // A fresh clock-offset measurement right before a shot, so the offset used to place the
        // trigger in this device's recording isn't minutes stale.
        if (data.armed) this.startSyncBurst();
        break;
      case 'clip-ack':
        this.clipAcknowledged$.next(data.triggerSeq);
        break;
      case 'trigger': {
        const masterTs = decodeTimestamp(data.masterTs);
        const rawLocalTs = masterTs - this.clockOffsetMs;
        const now = epochNow();
        // Guards against an unreliable/not-yet-synced offset (default 0) producing a wildly
        // wrong timestamp, which would otherwise make extraction wait far too long and miss
        // the master's clip-collection window entirely.
        const localTs = Math.abs(rawLocalTs - now) > 30_000 ? now : rawLocalTs;
        this.localTrigger$.next({
          localTs,
          masterTs,
          triggerSeq: data.triggerSeq,
          preRollSeconds: data.preRollSeconds,
          postRollSeconds: data.postRollSeconds,
        });
        break;
      }
      case 'session-ended':
        this.leaveSession();
        void this.router.navigate(['/session']);
        break;
    }
  }

  /** Each pong yields one clock-offset estimate whose error is bounded by half its round trip;
   *  the sample with the smallest round trip is the most trustworthy, so that one wins rather
   *  than whichever reply happened to arrive last. */
  private applySyncSample(pong: SyncPongMessage): void {
    const receivedAt = epochNow();
    const sentAt = decodeTimestamp(pong.sentAt);
    const roundTripMs = receivedAt - sentAt;
    // masterClock - thisDeviceClock, assuming the master handled the ping halfway through the trip.
    const offsetMs = decodeTimestamp(pong.receivedAt) - (sentAt + roundTripMs / 2);
    this.syncSamples = [...this.syncSamples, { roundTripMs, offsetMs }].slice(-SYNC_SAMPLES_KEPT);
    const best = this.syncSamples.reduce((a, b) => (b.roundTripMs < a.roundTripMs ? b : a));
    this.clockOffsetMs = best.offsetMs;
    this.isSynced.set(true);
  }

  private sendPing(): void {
    if (!this.masterConn?.open) return;
    const ping: SyncPingMessage = { type: 'sync-ping', sentAt: encodeTimestamp(epochNow()) };
    this.masterConn.send(ping);
  }

  private startSyncBurst(): void {
    if (this.syncBurstTimer) clearInterval(this.syncBurstTimer);
    let sent = 0;
    this.sendPing();
    sent += 1;
    this.syncBurstTimer = setInterval(() => {
      this.sendPing();
      sent += 1;
      if (sent >= SYNC_BURST_COUNT && this.syncBurstTimer) {
        clearInterval(this.syncBurstTimer);
        this.syncBurstTimer = null;
      }
    }, SYNC_BURST_INTERVAL_MS);
  }

  private startSyncLoop(): void {
    // A quick burst on connect to get a usable offset fast, then a steady trickle to track drift.
    this.startSyncBurst();
    this.syncTimer = setInterval(() => this.sendPing(), SYNC_INTERVAL_MS);
  }

  private teardown(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.syncBurstTimer) {
      clearInterval(this.syncBurstTimer);
      this.syncBurstTimer = null;
    }
    for (const conn of this.slaveConns.values()) conn.close();
    this.slaveConns.clear();
    this.masterConn?.close();
    this.masterConn = null;
    this.peer?.destroy();
    this.peer = null;
    this.clockOffsetMs = 0;
    this.syncSamples = [];
    this.isSynced.set(false);
    this.collectionProgress.set(null);
    this.slaveStates.set({});
    this.armed.set(false);
    this.selfId.set(null);
    this.triggerDeviceId.set(MASTER_TRIGGER_ID);
    this.masterRecordsVideo.set(true);
    this.nextTriggerSeq = 1;
  }
}
