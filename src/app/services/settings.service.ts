import { Injectable, signal } from '@angular/core';

export interface AppSettings {
  preRollSeconds: number;
  postRollSeconds: number;
  /** RMS amplitude (0-1) the mic must exceed to count as a release. */
  micSensitivity: number;
  chunkMs: number;
  /** Seconds to wait after a clip is ready before playback starts automatically. 0 disables autoplay. */
  autoplayDelaySeconds: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  preRollSeconds: 3,
  postRollSeconds: 2,
  micSensitivity: 0.05,
  chunkMs: 250,
  autoplayDelaySeconds: 2,
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
