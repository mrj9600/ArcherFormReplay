import { AppSettings } from './settings.service';

/** What a camera device is doing right now, as reported by slaves to the master (and shown for
 *  every device on the master's Record page). 'idle' means not recording and not doing anything
 *  for a shot - e.g. after finishing one, until the master returns to Record and re-arms it. */
export type DeviceState = 'idle' | 'armed' | 'capturing' | 'clipping' | 'sending' | 'error';

export const DEVICE_STATE_LABELS: Record<DeviceState, string> = {
  idle: 'Idle',
  armed: 'Waiting for trigger',
  capturing: 'Capturing',
  clipping: 'Clipping',
  sending: 'Sending',
  error: 'Failed',
};

/** Free-form numbers/strings about how a clip was made, shown in the timing debug readouts. */
export type ClipDebug = Record<string, string | number>;

export interface WelcomeMessage {
  type: 'welcome';
  settings: AppSettings;
}

export interface TriggerMessage {
  type: 'trigger';
  /** Monotonically increasing id for correlating clips to this trigger. */
  triggerSeq: number;
  /** Trigger time on the master's epoch clock (see time.ts), as a decimal string. */
  masterTs: string;
  /** The window every device clips around masterTs, fixed by the master at trigger time so all
   *  devices cut identical windows even if a setting changed mid-session. */
  preRollSeconds: number;
  postRollSeconds: number;
}

export interface SyncPingMessage {
  type: 'sync-ping';
  /** Sender's epoch clock (decimal string). */
  sentAt: string;
}

export interface SyncPongMessage {
  type: 'sync-pong';
  sentAt: string;
  /** Master's epoch clock when it handled the ping (decimal string). */
  receivedAt: string;
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
  /** Time of the clip's first frame on the master's epoch clock (decimal string), when the
   *  sender knows it exactly - lets Review line clips up by real time. */
  startEpochMs?: string;
  /** JSON-encoded ClipDebug (a string so the wire format can't mangle the numbers). */
  debug?: string;
}

/** Master -> slave: the clip for this trigger arrived intact. */
export interface ClipAckMessage {
  type: 'clip-ack';
  triggerSeq: number;
}

export interface TriggerAssignmentMessage {
  type: 'trigger-assignment';
  /** MASTER_TRIGGER_ID, or a slave's PeerJS id. */
  triggerDeviceId: string;
}

export interface RemoteTriggerMessage {
  type: 'remote-trigger';
  /** The reporting device's detection time converted to the master's epoch clock (decimal string). */
  estimatedMasterTs: string;
}

/** Master -> slaves: the master is (armed=true) / is no longer (armed=false) on the Record page.
 *  A slave records only while armed, and after delivering a clip stays idle until re-armed. */
export interface ArmMessage {
  type: 'arm';
  armed: boolean;
}

/** Slave -> master: this device's state changed. `triggerSeq` is set on the reply to a trigger
 *  (notably state 'idle' = "I wasn't recording, no clip is coming for this one"). */
export interface DeviceStateMessage {
  type: 'device-state';
  state: DeviceState;
  triggerSeq?: number;
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
  | ClipAckMessage
  | TriggerAssignmentMessage
  | RemoteTriggerMessage
  | ArmMessage
  | DeviceStateMessage
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
