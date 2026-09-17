import { Component, DestroyRef, ElementRef, OnInit, effect, inject, signal, viewChild } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { SettingsService } from '../../services/settings.service';
import { METER_DISPLAY_SCALE, SoundTriggerService } from '../../services/sound-trigger.service';
import { CameraService } from '../../services/camera.service';
import { APP_VERSION } from '../../version';

@Component({
  selector: 'app-settings',
  imports: [MatIconModule],
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
  protected readonly meterScale = METER_DISPLAY_SCALE;

  protected readonly cameraSelectRef = viewChild<ElementRef<HTMLSelectElement>>('cameraSelect');

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
      const preferred = this.camera.preferredDeviceId() ?? '';
      if (select && devices) {
        select.value = preferred;
      }
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
    this.camera.setPreferredDevice(value || null);
  }

  protected onPreRollInput(event: Event): void {
    this.settingsService.update({ preRollSeconds: Number((event.target as HTMLInputElement).value) });
  }

  protected onPostRollInput(event: Event): void {
    this.settingsService.update({ postRollSeconds: Number((event.target as HTMLInputElement).value) });
  }

  protected onSensitivityInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.settingsService.update({ micSensitivity: value });
    this.soundTrigger.setThreshold(value);
  }

  protected onAutoplayDelayInput(event: Event): void {
    this.settingsService.update({ autoplayDelaySeconds: Number((event.target as HTMLInputElement).value) });
  }

  protected meterPercent(): number {
    const pct = this.soundTrigger.level() * this.meterScale;
    return pct > 100 ? 100 : pct;
  }

  protected thresholdPercent(): number {
    const pct = this.settingsService.settings().micSensitivity * this.meterScale;
    return pct > 100 ? 100 : pct;
  }
}
