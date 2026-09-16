import { Injectable, signal } from '@angular/core';

export interface StoredClip {
  deviceLabel: string;
  url: string;
}

export interface ClipSet {
  capturedAt: number;
  clips: StoredClip[];
}

/** Holds the most recently captured clip (or set of clips, one per device) so Review can play them back. */
@Injectable({ providedIn: 'root' })
export class ClipStoreService {
  readonly clipSet = signal<ClipSet | null>(null);

  private objectUrls: string[] = [];

  setSingleClip(blob: Blob): void {
    this.setClips([{ deviceLabel: 'You', blob }]);
  }

  setClips(items: { deviceLabel: string; blob: Blob }[]): void {
    this.revokeAll();
    const clips = items.map((item) => ({ deviceLabel: item.deviceLabel, url: URL.createObjectURL(item.blob) }));
    this.objectUrls = clips.map((c) => c.url);
    this.clipSet.set({ capturedAt: Date.now(), clips });
  }

  private revokeAll(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }
}
