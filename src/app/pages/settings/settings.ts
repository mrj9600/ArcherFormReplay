import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { SettingsService } from '../../services/settings.service';
import { METER_DISPLAY_SCALE, SoundTriggerService } from '../../services/sound-trigger.service';
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
  private readonly destroyRef = inject(DestroyRef);

  protected readonly appVersion = APP_VERSION;

  protected readonly micError = signal<string | null>(null);
  protected readonly meterScale = METER_DISPLAY_SCALE;

  private micStream: MediaStream | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.soundTrigger.stop();
      this.micStream?.getTracks().forEach((track) => track.stop());
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.soundTrigger.start(this.micStream, this.settingsService.settings().micSensitivity);
    } catch (err) {
      this.micError.set(err instanceof Error ? err.message : 'Microphone access failed');
    }
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
