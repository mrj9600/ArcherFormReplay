import { Component, DestroyRef, ElementRef, OnInit, effect, inject, signal, viewChild } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { AUTO_RETURN_MANUAL, SettingsService } from '../../services/settings.service';
import { SoundTriggerService } from '../../services/sound-trigger.service';
import { CameraService } from '../../services/camera.service';
import { APP_VERSION } from '../../version';
import { MicCalibration } from '../../components/mic-calibration/mic-calibration';

const FRONT_OPTION_VALUE = '__front__';

@Component({
  selector: 'app-settings',
  imports: [MatIconModule, MicCalibration, RouterLink],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  protected readonly settingsService = inject(SettingsService);
  protected readonly soundTrigger = inject(SoundTriggerService);
  protected readonly camera = inject(CameraService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly appVersion = APP_VERSION;

  protected readonly micError = signal<string | null>(null);

  protected readonly cameraSelectRef = viewChild<ElementRef<HTMLSelectElement>>('cameraSelect');
  protected readonly frontOptionValue = FRONT_OPTION_VALUE;

  private micStream: MediaStream | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.soundTrigger.stop();
      this.micStream?.getTracks().forEach((track) => track.stop());
    });

    // A native <select>'s [value] binding can lose the selection once its <option>s finish
    // loading asynchronously (the browser has nothing to match against on the first render, and
    // Angular only re-applies the binding when the *source* value changes, not when a matching
    // option shows up later) - so the selection is set imperatively here instead, reacting to
    // both the device list and the stored preference.
    effect(() => {
      const select = this.cameraSelectRef()?.nativeElement;
      const devices = this.camera.devices();
      const preference = this.camera.preference();
      if (!select || !devices) return;
      select.value = preference.mode === 'device' ? preference.deviceId : preference.mode === 'front' ? FRONT_OPTION_VALUE : '';
    });
  }

  async ngOnInit(): Promise<void> {
    void this.camera.unlockDeviceLabels();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.soundTrigger.start(this.micStream, this.settingsService.settings().micSensitivity);
    } catch (err) {
      this.micError.set(err instanceof Error ? err.message : 'Microphone access failed');
    }
  }

  protected onCameraChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '') {
      this.camera.setPreference({ mode: 'default' });
    } else if (value === FRONT_OPTION_VALUE) {
      this.camera.setPreference({ mode: 'front' });
    } else {
      this.camera.setPreference({ mode: 'device', deviceId: value });
    }
  }

  /** The OS-reported label (e.g. "camera2 1, facing back") is often unreliable about facing, and
   *  is redundant with the dedicated Default/Front-facing options above - so it's stripped here. */
  protected cameraLabel(device: MediaDeviceInfo, index: number): string {
    const cleaned = device.label.replace(/,?\s*facing\s+(front|back)\s*$/i, '').trim();
    return cleaned || `Camera ${index + 1}`;
  }

  protected onPreRollInput(event: Event): void {
    this.settingsService.update({ preRollSeconds: Number((event.target as HTMLInputElement).value) });
  }

  protected onPostRollInput(event: Event): void {
    this.settingsService.update({ postRollSeconds: Number((event.target as HTMLInputElement).value) });
  }

  protected onSyncClipEndsChange(event: Event): void {
    this.settingsService.update({ syncClipEnds: (event.target as HTMLInputElement).checked });
  }

  protected onPreciseCaptureChange(event: Event): void {
    this.settingsService.update({ preciseCapture: (event.target as HTMLInputElement).checked });
  }

  protected onTimingOffsetChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.settingsService.update({ videoTimingOffsetMs: Number.isFinite(value) ? value : 0 });
  }

  protected readonly autoReturnLoopOptions = [1, 2, 3, 4, 5];

  protected autoReturnValue(): string {
    const loops = this.settingsService.settings().autoReturnLoops;
    if (loops === AUTO_RETURN_MANUAL) return 'manual';
    return loops > 0 ? String(loops) : 'off';
  }

  protected onAutoReturnChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const autoReturnLoops = value === 'manual' ? AUTO_RETURN_MANUAL : value === 'off' ? 0 : Number(value);
    this.settingsService.update({ autoReturnLoops });
  }

  protected onAutoSaveClipsChange(event: Event): void {
    this.settingsService.update({ autoSaveClips: (event.target as HTMLInputElement).checked });
  }
}
