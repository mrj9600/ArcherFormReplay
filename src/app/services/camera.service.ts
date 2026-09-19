import { Injectable, inject, signal } from '@angular/core';
import { SettingsService } from './settings.service';

export type CameraPreference = { mode: 'default' } | { mode: 'front' } | { mode: 'device'; deviceId: string };

const PREFERENCE_KEY = 'archer-form-replay.cameraPreference';

@Injectable({ providedIn: 'root' })
export class CameraService {
  private readonly settingsService = inject(SettingsService);

  readonly stream = signal<MediaStream | null>(null);
  readonly devices = signal<MediaDeviceInfo[]>([]);
  readonly error = signal<string | null>(null);
  /** The user's chosen camera for this device (local hardware choice - never synced between devices in a session). */
  readonly preference = signal<CameraPreference>(this.loadPreference());

  setPreference(preference: CameraPreference): void {
    this.preference.set(preference);
    try {
      localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preference));
    } catch {
      // localStorage unavailable - the choice just won't persist across reloads.
    }
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    const cameras = all.filter((d) => d.kind === 'videoinput');
    this.devices.set(cameras);
    return cameras;
  }

  /** Briefly opens the camera (if needed) so enumerateDevices() returns real labels instead of blank ones. */
  async unlockDeviceLabels(): Promise<void> {
    const cameras = await this.listCameras();
    if (cameras.length === 0 || cameras.some((c) => c.label)) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      await this.listCameras();
    } catch {
      // Permission denied or no camera available - leave labels blank.
    }
  }

  /** Opens a video stream, with audio only when requested (master needs it for release detection; slaves don't). */
  async start(deviceId?: string, withAudio = true): Promise<MediaStream> {
    this.stop();
    const target: CameraPreference = deviceId ? { mode: 'device', deviceId } : this.preference();
    try {
      return await this.open(target, withAudio);
    } catch (err) {
      // The preferred camera may no longer exist (unplugged, etc.) - fall back to the default
      // camera rather than failing outright.
      if (target.mode !== 'default') {
        try {
          return await this.open({ mode: 'default' }, withAudio);
        } catch {
          // fall through to the original error below
        }
      }
      const message = err instanceof Error ? err.message : 'Camera/microphone access failed';
      this.error.set(message);
      throw err;
    }
  }

  stop(): void {
    this.stream()?.getTracks().forEach((track) => track.stop());
    this.stream.set(null);
  }

  private async open(preference: CameraPreference, withAudio: boolean): Promise<MediaStream> {
    const video: MediaTrackConstraints =
      preference.mode === 'device'
        ? { deviceId: { exact: preference.deviceId } }
        : { facingMode: preference.mode === 'front' ? 'user' : 'environment' };
    // Best-effort requests (ideal, never exact, so a camera that can't do it still opens): 720p is
    // enough detail for form review and the most that phones reliably offer at 60 fps.
    const constrained: MediaTrackConstraints = {
      ...video,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: this.settingsService.settings().frameRate },
    };
    const stream = await navigator.mediaDevices.getUserMedia({ video: constrained, audio: withAudio });
    this.stream.set(stream);
    this.error.set(null);
    await this.listCameras();
    return stream;
  }

  private loadPreference(): CameraPreference {
    try {
      const raw = localStorage.getItem(PREFERENCE_KEY);
      if (!raw) return { mode: 'default' };
      const parsed = JSON.parse(raw) as Partial<CameraPreference>;
      if (parsed?.mode === 'front' || parsed?.mode === 'default') return { mode: parsed.mode };
      if (parsed?.mode === 'device' && typeof (parsed as { deviceId?: unknown }).deviceId === 'string') {
        return { mode: 'device', deviceId: (parsed as { deviceId: string }).deviceId };
      }
      return { mode: 'default' };
    } catch {
      return { mode: 'default' };
    }
  }
}
