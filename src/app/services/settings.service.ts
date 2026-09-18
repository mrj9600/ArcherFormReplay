import { Injectable, signal } from '@angular/core';

export interface AppSettings {
  preRollSeconds: number;
  postRollSeconds: number;
  /** Peak amplitude (0-1) the mic must exceed to count as a release. */
  micSensitivity: number;
  /** When multiple clips have different lengths, slow the shorter ones down so every clip ends at the same time. */
  syncClipEnds: boolean;
  /** How many times to auto-play the review before returning to Record. 0 disables auto-return. */
  autoReturnLoops: number;
  /** Skip Review entirely - download each clip straight to the device as soon as it's captured. */
  autoSaveClips: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  preRollSeconds: 3,
  postRollSeconds: 2,
  micSensitivity: 0.04,
  syncClipEnds: true,
  autoReturnLoops: 0,
  autoSaveClips: false,
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
