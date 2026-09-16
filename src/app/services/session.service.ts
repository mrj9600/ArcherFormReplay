import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import Peer, { DataConnection } from 'peerjs';
import { SettingsService } from './settings.service';
import {
  ClipMetaMessage,
  ROOM_ID_PREFIX,
  SessionMessage,
  SyncPingMessage,
  SyncPongMessage,
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
  triggerMasterTs: number;
}

const SYNC_PING_COUNT = 5;
const SYNC_INTERVAL_MS = 15_000;

/**
 * Owns the PeerJS connection(s) for a pairing session and speaks the small JSON+binary
 * protocol in session-protocol.ts. One device is "master" (creates the room, detects the
 * release, broadcasts the trigger); others join as "slave" and send their clip back.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly settingsService = inject(SettingsService);

  readonly role = signal<SessionRole>('none');
  readonly roomCode = signal<string | null>(null);
  readonly connectionState = signal<SessionConnectionState>('idle');
  readonly error = signal<string | null>(null);
  readonly connectedSlaves = signal<ConnectedSlave[]>([]);

  /** Slave only: fires with this device's own clock timestamp (and the original master timestamp) when the master triggers. */
  readonly localTrigger$ = new Subject<{ localTs: number; masterTs: number }>();
  /** Master only: fires as each slave's clip arrives. */
  readonly clipReceived$ = new Subject<IncomingClip>();

  private peer: Peer | null = null;
  private masterConn: DataConnection | null = null;
  private readonly slaveConns = new Map<string, DataConnection>();
  private readonly pendingClipMeta = new Map<string, { mimeType: string; triggerMasterTs: number }>();
  /** Slave only: estimated (masterClock - thisDeviceClock) at the same real-world instant. */
  private clockOffsetMs = 0;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  async startMaster(): Promise<string> {
    this.teardown();
    this.role.set('master');
    this.connectionState.set('connecting');

    return new Promise((resolve, reject) => {
      const code = generateRoomCode();
      const peer = new Peer(`${ROOM_ID_PREFIX}${code}`);
      this.peer = peer;

      peer.on('open', () => {
        this.roomCode.set(code);
        this.connectionState.set('connected');
        resolve(code);
      });
      peer.on('connection', (conn) => this.acceptSlaveConnection(conn));
      peer.on('error', (err) => {
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
    const code = rawCode.trim().toUpperCase();

    return new Promise((resolve, reject) => {
      const peer = new Peer();
      this.peer = peer;

      peer.on('open', () => {
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

  /** Master only: broadcast a trigger (alongside extracting your own local clip). */
  broadcastTrigger(masterTs: number): void {
    const message: TriggerMessage = { type: 'trigger', masterTs };
    for (const conn of this.slaveConns.values()) {
      if (conn.open) conn.send(message);
    }
  }

  /** Slave only: send this device's clip back to master for a given trigger. */
  sendClip(blob: Blob, mimeType: string, triggerMasterTs: number): void {
    if (!this.masterConn?.open) return;
    const meta: ClipMetaMessage = { type: 'clip-meta', mimeType, triggerMasterTs };
    this.masterConn.send(meta);
    this.masterConn.send(blob);
  }

  /** How many slaves are expected to send a clip back right now. */
  get expectedClipCount(): number {
    return this.slaveConns.size;
  }

  /**
   * Master only: waits for a clip from every currently-connected slave for this trigger,
   * resolving early once all have arrived, or after `timeoutMs` with whatever did.
   */
  collectClips(masterTs: number, timeoutMs = 10_000): Promise<Map<string, Blob>> {
    const expectedIds = [...this.slaveConns.keys()];
    return new Promise((resolve) => {
      const collected = new Map<string, Blob>();
      if (expectedIds.length === 0) {
        resolve(collected);
        return;
      }

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve(collected);
      };

      const subscription = this.clipReceived$.subscribe(({ slaveId, blob, triggerMasterTs }) => {
        if (triggerMasterTs !== masterTs) return;
        collected.set(slaveId, blob);
        if (collected.size >= expectedIds.length) finish();
      });
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  private acceptSlaveConnection(conn: DataConnection): void {
    conn.on('open', () => {
      this.slaveConns.set(conn.peer, conn);
      this.connectedSlaves.set([...this.connectedSlaves(), { id: conn.peer, connectedAt: Date.now() }]);
      const welcome: WelcomeMessage = { type: 'welcome', settings: this.settingsService.settings() };
      conn.send(welcome);
    });
    conn.on('data', (data) => this.handleMasterIncomingData(conn, data));
    conn.on('close', () => this.removeSlave(conn.peer));
    conn.on('error', () => this.removeSlave(conn.peer));
  }

  private removeSlave(id: string): void {
    this.slaveConns.delete(id);
    this.pendingClipMeta.delete(id);
    this.connectedSlaves.set(this.connectedSlaves().filter((s) => s.id !== id));
  }

  private handleMasterIncomingData(conn: DataConnection, data: unknown): void {
    if (data instanceof Blob) {
      const meta = this.pendingClipMeta.get(conn.peer);
      if (meta) {
        this.pendingClipMeta.delete(conn.peer);
        this.clipReceived$.next({ slaveId: conn.peer, blob: data, triggerMasterTs: meta.triggerMasterTs });
      }
      return;
    }
    if (data instanceof ArrayBuffer) {
      const meta = this.pendingClipMeta.get(conn.peer);
      if (meta) {
        this.pendingClipMeta.delete(conn.peer);
        this.clipReceived$.next({
          slaveId: conn.peer,
          blob: new Blob([data], { type: meta.mimeType }),
          triggerMasterTs: meta.triggerMasterTs,
        });
      }
      return;
    }
    if (!isSessionMessage(data)) return;

    if (data.type === 'sync-ping') {
      const pong: SyncPongMessage = { type: 'sync-pong', sentAt: data.sentAt, receivedAt: performance.now() };
      conn.send(pong);
    } else if (data.type === 'clip-meta') {
      this.pendingClipMeta.set(conn.peer, { mimeType: data.mimeType, triggerMasterTs: data.triggerMasterTs });
    }
  }

  private handleSlaveIncomingData(data: unknown): void {
    if (!isSessionMessage(data)) return;

    switch (data.type) {
      case 'welcome':
        this.settingsService.update(data.settings);
        break;
      case 'sync-pong':
        this.applySyncSample(data);
        break;
      case 'trigger':
        this.localTrigger$.next({ localTs: data.masterTs - this.clockOffsetMs, masterTs: data.masterTs });
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
  }

  private startSyncLoop(): void {
    let pingsSent = 0;
    const sendPing = () => {
      if (!this.masterConn?.open) return;
      const ping: SyncPingMessage = { type: 'sync-ping', sentAt: performance.now() };
      this.masterConn.send(ping);
    };

    // A quick burst on connect to get a usable offset fast, then a steady trickle to track drift.
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
    this.pendingClipMeta.clear();
    this.masterConn?.close();
    this.masterConn = null;
    this.peer?.destroy();
    this.peer = null;
    this.clockOffsetMs = 0;
  }
}
