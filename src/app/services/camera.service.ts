import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class CameraService {
  readonly stream = signal<MediaStream | null>(null);
  readonly devices = signal<MediaDeviceInfo[]>([]);
  readonly error = signal<string | null>(null);

  async listCameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    const cameras = all.filter((d) => d.kind === 'videoinput');
    this.devices.set(cameras);
    return cameras;
  }

  /** Opens a combined video+audio stream. Audio is included even on slave devices so clips have sound on playback. */
  async start(deviceId?: string): Promise<MediaStream> {
    this.stop();
    try {
      const video: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: 'environment' };
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      this.stream.set(stream);
      this.error.set(null);
      await this.listCameras();
      return stream;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Camera/microphone access failed';
      this.error.set(message);
      throw err;
    }
  }

  stop(): void {
    this.stream()?.getTracks().forEach((track) => track.stop());
    this.stream.set(null);
  }
}
