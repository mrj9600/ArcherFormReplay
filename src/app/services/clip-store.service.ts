import { Injectable, signal } from '@angular/core';

export interface StoredClip {
  deviceLabel: string;
  url: string;
  mimeType: string;
  /** Epoch ms on the master's clock at which this clip's first frame was captured, when known exactly. */
  startEpochMs: number | null;
  /** Timing debug numbers about how this clip was captured/cut. */
  debug: Record<string, string | number> | null;
}

export interface ClipSet {
  capturedAt: number;
  clips: StoredClip[];
  note?: string;
}

const AUTO_SAVE_SESSION_GAP_MS = 30 * 60 * 1000;

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Holds the most recently captured clip (or set of clips, one per device) so Review can play them back. */
@Injectable({ providedIn: 'root' })
export class ClipStoreService {
  readonly clipSet = signal<ClipSet | null>(null);

  private objectUrls: string[] = [];
  private autoSaveShot: { timestamp: string; shotNumber: number; lastShotAt: number } | null = null;

  setSingleClip(blob: Blob): void {
    this.setClips([{ deviceLabel: 'You', blob }]);
  }

  setClips(items: { deviceLabel: string; blob: Blob; startEpochMs?: number | null; debug?: Record<string, string | number> | null }[], note?: string): void {
    this.revokeAll();
    const clips = items.map((item) => ({
      deviceLabel: item.deviceLabel,
      url: URL.createObjectURL(item.blob),
      mimeType: item.blob.type || 'video/webm',
      startEpochMs: item.startEpochMs ?? null,
      debug: item.debug ?? null,
    }));
    this.objectUrls = clips.map((c) => c.url);
    this.clipSet.set({ capturedAt: Date.now(), clips, note });
  }

  /** Naming info for the next auto-saved shot. The timestamp is fixed to the first shot of a
   *  shooting session and only the shot number advances - a session survives Record being left and
   *  re-entered between shots (Review sits in between), and ends after a long gap with no shots. */
  nextAutoSaveShot(): { timestamp: string; shotNumber: number } {
    const now = Date.now();
    if (!this.autoSaveShot || now - this.autoSaveShot.lastShotAt > AUTO_SAVE_SESSION_GAP_MS) {
      this.autoSaveShot = { timestamp: formatTimestamp(new Date(now)), shotNumber: 0, lastShotAt: now };
    }
    this.autoSaveShot.shotNumber += 1;
    this.autoSaveShot.lastShotAt = now;
    return { timestamp: this.autoSaveShot.timestamp, shotNumber: this.autoSaveShot.shotNumber };
  }

  private revokeAll(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }
}
