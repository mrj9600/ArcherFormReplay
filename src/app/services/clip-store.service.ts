import { Injectable, signal } from '@angular/core';

export interface StoredClip {
  url: string;
  capturedAt: number;
}

/** Holds the most recently captured clip so the Review page can play it back. */
@Injectable({ providedIn: 'root' })
export class ClipStoreService {
  readonly clip = signal<StoredClip | null>(null);

  private objectUrl: string | null = null;

  setClip(blob: Blob): void {
    this.revoke();
    this.objectUrl = URL.createObjectURL(blob);
    this.clip.set({ url: this.objectUrl, capturedAt: Date.now() });
  }

  private revoke(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
