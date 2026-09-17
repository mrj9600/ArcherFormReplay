import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { Router } from '@angular/router';
import Peer, { DataConnection } from 'peerjs';
import { SettingsService } from './settings.service';
import {
  ClipMessage,
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
  localTs: number;
  masterTs: number;
  triggerSeq: number;
}

const SYNC_PING_COUNT = 5;
const SYNC_INTERVAL_MS = 15_000;
const MAX_ROOM_CODE_ATTEMPTS = 5;

/**
 * Owns the PeerJS connection(s) for a pairing session and speaks the small JSON+binary
 * protocol in session-protocol.ts. One device is "master" (creates the room, coordinates
 * clip collection); others join as "slave" and send their clip back. Either the master or
 * any connected slave can be assigned as the "trigger device" - the one whose microphone
 * actually detects the release - independent of who's hosting the session.
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

  /** Slave only: fires with this device's own clock timestamp (and the original master timestamp) when the master triggers. */
  readonly localTrigger$ = new Subject<LocalTriggerEvent>();
  /** Master only: fires as each slave's clip arrives. */
  readonly clipReceived$ = new Subject<IncomingClip>();
  /** Master only: fires when the assigned trigger device is a slave reporting a detected release. */
  readonly remoteTriggerRequested$ = new Subject<number>();

  private peer: Peer | null = null;
  private masterConn: DataConnection | null = null;
  private readonly slaveConns = new Map<string, DataConnection>();
  /** Slave only: estimated (masterClock - thisDeviceClock) at the same real-world instant. */
  private clockOffsetMs = 0;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
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

  /** Master only: broadcast a trigger (alongside extracting your own local clip, if recording). Returns the sequence id to pass to collectClips. */
  broadcastTrigger(masterTs: number): number {
    const triggerSeq = this.nextTriggerSeq++;
    const message: TriggerMessage = { type: 'trigger', triggerSeq, masterTs };
    this.sendToAllSlaves(message);
    return triggerSeq;
  }

  /** Slave only, when assigned as the trigger device: tell master a release was just detected/requested. */
  reportLocalTrigger(localTs: number): void {
    if (!this.masterConn?.open) return;
    const message: RemoteTriggerMessage = { type: 'remote-trigger', estimatedMasterTs: localTs + this.clockOffsetMs };
    this.masterConn.send(message);
  }

  /** Slave only: send this device's clip back to master for a given trigger. */
  sendClip(blob: Blob, mimeType: string, triggerSeq: number): void {
    if (!this.masterConn?.open) return;
    const message: ClipMessage = { type: 'clip', triggerSeq, mimeType, data: blob };
    this.masterConn.send(message);
  }

  /** How many slaves are expected to send a clip back right now. */
  get expectedClipCount(): number {
    return this.slaveConns.size;
  }

  /**
   * Master only: waits for a clip from every currently-connected slave for this trigger,
   * resolving early once all have arrived, or after `timeoutMs` with whatever did.
   */
  collectClips(triggerSeq: number, timeoutMs = 15_000): Promise<Map<string, Blob>> {
    const expectedIds = [...this.slaveConns.keys()];
    return new Promise((resolve) => {
      const collected = new Map<string, Blob>();
      if (expectedIds.length === 0) {
        resolve(collected);
        return;
      }
      this.collectionProgress.set({ received: 0, expected: expectedIds.length });

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        subscription.unsubscribe();
        this.collectionProgress.set(null);
        resolve(collected);
      };

      const subscription = this.clipReceived$.subscribe((clip) => {
        if (clip.triggerSeq !== triggerSeq) return;
        collected.set(clip.slaveId, clip.blob);
        this.collectionProgress.set({ received: collected.size, expected: expectedIds.length });
        if (collected.size >= expectedIds.length) finish();
      });
      const timer = setTimeout(finish, timeoutMs);
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
      const welcome: WelcomeMessage = { type: 'welcome', settings: this.settingsService.settings() };
      conn.send(welcome);
      const assignment: TriggerAssignmentMessage = { type: 'trigger-assignment', triggerDeviceId: this.triggerDeviceId() };
      conn.send(assignment);
    });
    conn.on('data', (data) => this.handleMasterIncomingData(conn, data));
    conn.on('close', () => this.removeSlave(conn.peer));
    conn.on('error', () => this.removeSlave(conn.peer));
  }

  private removeSlave(id: string): void {
    this.slaveConns.delete(id);
    this.connectedSlaves.set(this.connectedSlaves().filter((s) => s.id !== id));
    // The assigned trigger device just left - fall back to the master so the session stays usable.
    if (this.triggerDeviceId() === id) {
      this.triggerDeviceId.set(MASTER_TRIGGER_ID);
    }
  }

  private handleMasterIncomingData(conn: DataConnection, data: unknown): void {
    if (!isSessionMessage(data)) return;

    if (data.type === 'sync-ping') {
      const pong: SyncPongMessage = { type: 'sync-pong', sentAt: data.sentAt, receivedAt: performance.now() };
      conn.send(pong);
    } else if (data.type === 'clip') {
      const raw = data.data;
      const blob = raw instanceof Blob ? raw : new Blob([raw], { type: data.mimeType });
      this.clipReceived$.next({ slaveId: conn.peer, blob, triggerSeq: data.triggerSeq });
    } else if (data.type === 'remote-trigger') {
      this.remoteTriggerRequested$.next(data.estimatedMasterTs);
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
      case 'trigger': {
        const rawLocalTs = data.masterTs - this.clockOffsetMs;
        const now = performance.now();
        // Guards against an unreliable/not-yet-synced offset (default 0) producing a wildly
        // wrong timestamp, which would otherwise make extraction wait far too long and miss
        // the master's clip-collection window entirely.
        const localTs = Math.abs(rawLocalTs - now) > 30_000 ? now : rawLocalTs;
        this.localTrigger$.next({ localTs, masterTs: data.masterTs, triggerSeq: data.triggerSeq });
        break;
      }
      case 'session-ended':
        this.leaveSession();
        void this.router.navigate(['/session']);
        break;
    }
  }

  private applySyncSample(pong: SyncPongMessage): void {
    const receivedAt = performance.now();
    const roundTripMs = receivedAt - pong.sentAt;
    const oneWayMs = roundTripMs / 2;
    // masterClock - thisDeviceClock, estimated at the moment this reply arrived.
    const offsetSample = pong.receivedAt - pong.sentAt - oneWayMs;
    this.clockOffsetMs = offsetSample;
    this.isSynced.set(true);
  }

  private startSyncLoop(): void {
    let pingsSent = 0;
    const sendPing = () => {
      if (!this.masterConn?.open) return;
      const ping: SyncPingMessage = { type: 'sync-ping', sentAt: performance.now() };
      this.masterConn.send(ping);
    };

    // A quick burst on connect to get a usable offset fast (first ping immediate), then a
    // steady trickle to track drift.
    sendPing();
    pingsSent += 1;
    const burst = setInterval(() => {
      sendPing();
      pingsSent += 1;
      if (pingsSent >= SYNC_PING_COUNT) clearInterval(burst);
    }, 300);

    this.syncTimer = setInterval(sendPing, SYNC_INTERVAL_MS);
  }

  private teardown(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    for (const conn of this.slaveConns.values()) conn.close();
    this.slaveConns.clear();
    this.masterConn?.close();
    this.masterConn = null;
    this.peer?.destroy();
    this.peer = null;
    this.clockOffsetMs = 0;
    this.isSynced.set(false);
    this.collectionProgress.set(null);
    this.selfId.set(null);
    this.triggerDeviceId.set(MASTER_TRIGGER_ID);
    this.masterRecordsVideo.set(true);
    this.nextTriggerSeq = 1;
  }
}
