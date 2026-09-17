import { AppSettings } from './settings.service';

export interface WelcomeMessage {
  type: 'welcome';
  settings: AppSettings;
}

export interface TriggerMessage {
  type: 'trigger';
  /** Monotonically increasing id for correlating clips to this trigger. Integers round-trip
   *  exactly through the wire format; the timestamps below don't reliably (see ClipMessage). */
  triggerSeq: number;
  /** Trigger timestamp on the master's performance.now() clock. */
  masterTs: number;
}

export interface SyncPingMessage {
  type: 'sync-ping';
  sentAt: number;
}

export interface SyncPongMessage {
  type: 'sync-pong';
  sentAt: number;
  receivedAt: number;
}

/**
 * Carries the clip's Blob nested as a property so metadata and data always arrive as a single
 * atomic message - no separate messages to keep in order or correlate by hand.
 */
export interface ClipMessage {
  type: 'clip';
  triggerSeq: number;
  mimeType: string;
  /** Sent as a Blob; arrives as an ArrayBuffer after the wire format round-trip. */
  data: Blob | ArrayBuffer;
}

export interface TriggerAssignmentMessage {
  type: 'trigger-assignment';
  /** MASTER_TRIGGER_ID, or a slave's PeerJS id. */
  triggerDeviceId: string;
}

export interface RemoteTriggerMessage {
  type: 'remote-trigger';
  /** The reporting device's local detection timestamp, already converted to the master's clock. */
  estimatedMasterTs: number;
}

/** Master -> slaves: the master stopped the session - every slave should leave too. */
export interface SessionEndedMessage {
  type: 'session-ended';
}

export type SessionMessage =
  | WelcomeMessage
  | TriggerMessage
  | SyncPingMessage
  | SyncPongMessage
  | ClipMessage
  | TriggerAssignmentMessage
  | RemoteTriggerMessage
  | SessionEndedMessage;

/** Sentinel triggerDeviceId meaning "the master itself", since the master has no PeerJS id from its own perspective worth tracking separately. */
export const MASTER_TRIGGER_ID = '__master__';

export function isSessionMessage(data: unknown): data is SessionMessage {
  return typeof data === 'object' && data !== null && typeof (data as { type?: unknown }).type === 'string';
}

/** Devices connect as `${ROOM_ID_PREFIX}${code}` so PeerJS IDs don't collide with unrelated public-broker peers. */
export const ROOM_ID_PREFIX = 'archer-form-replay-';

export function generateRoomCode(): string {
  return String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
}
