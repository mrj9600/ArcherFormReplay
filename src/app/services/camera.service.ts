import { Injectable, inject, signal } from '@angular/core';
import { SettingsService } from './settings.service';

export type CameraPreference = { mode: 'default' } | { mode: 'front' } | { mode: 'device'; deviceId: string };

export interface FrameRateProbe {
  /** What the camera track itself reports as its limits. */
  capabilities: string;
  rows: { size: string; normal: string; highRate: string }[];
}

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

  private videoBase(preference: CameraPreference): MediaTrackConstraints {
    return preference.mode === 'device'
      ? { deviceId: { exact: preference.deviceId } }
      : { facingMode: preference.mode === 'front' ? 'user' : 'environment' };
  }

  private async open(preference: CameraPreference, withAudio: boolean): Promise<MediaStream> {
    const base = this.videoBase(preference);
    const fps = this.settingsService.settings().frameRate;
    // 720p is enough detail for form review and the most phones reliably offer at 60 fps. With ideal
    // (soft) constraints the browser may settle for a 30 fps format that happens to match 720p best,
    // so a 60 fps request first tries a hard "at least 50 fps" - any resolution that can do it wins -
    // and only falls back to the soft request if no format qualifies.
    const attempts: MediaTrackConstraints[] = [];
    if (fps > 45) {
      attempts.push({ ...base, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { min: 50, ideal: fps } });
    }
    attempts.push({ ...base, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: fps } });

    let stream: MediaStream | null = null;
    for (const video of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: withAudio });
        break;
      } catch (err) {
        if ((err as { name?: string })?.name !== 'OverconstrainedError') throw err;
      }
    }
    if (!stream) throw new Error('No camera format matched the requested settings');
    this.stream.set(stream);
    this.error.set(null);
    await this.listCameras();
    return stream;
  }

  /**
   * Finds out what this camera really offers: for each resolution, what the browser grants by
   * default and whether it will give at least 50 fps, each with the frame rate actually delivered
   * over about a second (a granted setting and real delivery can differ). Uses the currently
   * chosen camera. Meant for the Settings page's "test camera frame rates" button.
   */
  async probeFrameRates(): Promise<FrameRateProbe> {
    const base = this.videoBase(this.preference());
    const sizes: [number, number][] = [
      [640, 480],
      [1280, 720],
      [1920, 1080],
    ];
    let capabilities = 'unknown';
    const rows: FrameRateProbe['rows'] = [];
    for (const [width, height] of sizes) {
      const size = `${width}x${height}`;
      const normal = await this.tryFormat({ ...base, width: { exact: width }, height: { exact: height } });
      const highRate = await this.tryFormat({ ...base, width: { exact: width }, height: { exact: height }, frameRate: { min: 50 } });
      if (capabilities === 'unknown') capabilities = normal.capabilities ?? highRate.capabilities ?? 'unknown';
      rows.push({ size, normal: normal.text, highRate: highRate.text });
    }
    return { capabilities, rows };
  }

  private async tryFormat(video: MediaTrackConstraints): Promise<{ text: string; capabilities?: string }> {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video });
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : undefined;
      const capabilities = caps
        ? `up to ${caps.frameRate?.max ?? '?'} fps, ${caps.width?.max ?? '?'}x${caps.height?.max ?? '?'}`
        : undefined;
      const delivered = await this.measureDeliveredFps(stream);
      return {
        text: `granted ${settings.frameRate ?? '?'} fps, delivered ${delivered !== null ? delivered.toFixed(1) : '?'} fps`,
        capabilities,
      };
    } catch (err) {
      return { text: `not offered (${(err as { name?: string })?.name ?? 'error'})` };
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  private async measureDeliveredFps(stream: MediaStream): Promise<number | null> {
    const video = document.createElement('video');
    if (!('requestVideoFrameCallback' in video)) return null;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      return null;
    }
    let count = 0;
    let firstAt = 0;
    let lastAt = 0;
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const onFrame = (now: number) => {
        count++;
        if (!firstAt) firstAt = now;
        lastAt = now;
        if (performance.now() - startedAt < 1200) video.requestVideoFrameCallback(onFrame);
        else resolve();
      };
      video.requestVideoFrameCallback(onFrame);
      setTimeout(resolve, 3000);
    });
    video.pause();
    video.srcObject = null;
    return count > 2 && lastAt > firstAt ? (count - 1) / ((lastAt - firstAt) / 1000) : null;
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
