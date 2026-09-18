import { Injectable, signal } from '@angular/core';

export interface AppSettings {
  preRollSeconds: number;
  postRollSeconds: number;
  /** Peak amplitude (0-1) the mic must exceed to count as a release. */
  micSensitivity: number;
  /** When multiple clips have different lengths, slow the shorter ones down so every clip ends at the same time. */
  syncClipEnds: boolean;
  /** What happens after a shot: 0 = off (skip Review, stay on Record and re-arm),
   *  AUTO_RETURN_MANUAL = open Review and go back manually, 1-5 = open Review and return to
   *  Record automatically after playing that many times. */
  autoReturnLoops: number;
  /** Also download each clip straight to the device as soon as it's captured, independent of what happens after the shot (see autoReturnLoops). */
  autoSaveClips: boolean;
}

export const AUTO_RETURN_MANUAL = -1;

const DEFAULT_SETTINGS: AppSettings = {
  preRollSeconds: 3,
  postRollSeconds: 2,
  micSensitivity: 0.04,
  syncClipEnds: true,
  autoReturnLoops: AUTO_RETURN_MANUAL,
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
