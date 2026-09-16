import { AppSettings } from './settings.service';

export interface WelcomeMessage {
  type: 'welcome';
  settings: AppSettings;
}

export interface TriggerMessage {
  type: 'trigger';
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

export interface ClipMetaMessage {
  type: 'clip-meta';
  mimeType: string;
  triggerMasterTs: number;
}

export type SessionMessage =
  | WelcomeMessage
  | TriggerMessage
  | SyncPingMessage
  | SyncPongMessage
  | ClipMetaMessage;

export function isSessionMessage(data: unknown): data is SessionMessage {
  return typeof data === 'object' && data !== null && typeof (data as { type?: unknown }).type === 'string';
}

/** Devices connect as `${ROOM_ID_PREFIX}${code}` so PeerJS IDs don't collide with unrelated public-broker peers. */
export const ROOM_ID_PREFIX = 'archer-form-replay-';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - avoids visual ambiguity

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}
