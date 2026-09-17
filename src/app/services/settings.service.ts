import { Injectable, signal } from '@angular/core';

export interface AppSettings {
  preRollSeconds: number;
  postRollSeconds: number;
  /** Peak amplitude (0-1) the mic must exceed to count as a release. */
  micSensitivity: number;
  /** Seconds to wait after all clips are ready (or the collection has timed out) before playback starts automatically. 0 disables autoplay. */
  autoplayDelaySeconds: number;
  /** When multiple clips have different lengths, slow the shorter ones down so every clip ends at the same time. */
  syncClipEnds: boolean;
  /** How many times to auto-play the review before returning to Record. 0 disables auto-return. */
  autoReturnLoops: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  preRollSeconds: 3,
  postRollSeconds: 2,
  micSensitivity: 0.04,
  autoplayDelaySeconds: 2,
  syncClipEnds: true,
  autoReturnLoops: 0,
};

const STORAGE_KEY = 'archer-form-replay.settings';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly settings = signal<AppSettings>(this.load());

  update(patch: Partial<AppSettings>): void {
    const next = { ...this.settings(), ...patch };
    this.settings.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable (private browsing, etc.) - settings just won't persist.
    }
  }

  private load(): AppSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
}
