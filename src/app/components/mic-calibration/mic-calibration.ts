import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { METER_DISPLAY_SCALE, SoundTriggerService } from '../../services/sound-trigger.service';
import { SettingsService } from '../../services/settings.service';

const MIN_SENSITIVITY = 0.005;
const MAX_SENSITIVITY = 0.3;
const SENSITIVITY_STEP = 0.005;

/**
 * The live mic level meter and the sensitivity threshold it's compared against, combined into
 * one draggable bar instead of a meter plus a separate slider below it - drag (or tap) anywhere
 * on the bar to move the threshold marker. Shared between Settings (where the trigger mic is
 * started specifically for calibration) and Record (where it's already running for real
 * detection) - this component only reads the live level/threshold and writes the threshold back,
 * it doesn't own acquiring the microphone itself.
 */
@Component({
  selector: 'app-mic-calibration',
  templateUrl: './mic-calibration.html',
  styleUrl: './mic-calibration.scss',
})
export class MicCalibration {
  protected readonly soundTrigger = inject(SoundTriggerService);
  protected readonly settingsService = inject(SettingsService);
  protected readonly meterScale = METER_DISPLAY_SCALE;

  protected readonly trackRef = viewChild<ElementRef<HTMLDivElement>>('track');

  protected meterPercent(): number {
    const pct = this.soundTrigger.level() * this.meterScale;
    return pct > 100 ? 100 : pct;
  }

  protected thresholdPercent(): number {
    const pct = this.settingsService.settings().micSensitivity * this.meterScale;
    return pct > 100 ? 100 : pct;
  }

  protected onPointerDown(event: PointerEvent): void {
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Capture failing (e.g. no active pointer with this id) shouldn't block setting the value
      // from this tap - it only means a subsequent drag outside the element's bounds won't keep
      // tracking, which is a minor UX loss, not a broken control.
    }
    this.updateFromPointer(event.clientX);
  }

  protected onPointerMove(event: PointerEvent): void {
    // Only real drags reach here once pointer capture is set on down - buttons check is just a
    // defensive fallback for a stray move event with no button actually held.
    if (event.buttons === 0) return;
    this.updateFromPointer(event.clientX);
  }

  private updateFromPointer(clientX: number): void {
    const track = this.trackRef()?.nativeElement;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    // Inverse of thresholdPercent()'s value * meterScale - valid as long as the resulting value
    // stays under the meter's 100%-at-1/meterScale ceiling, which MAX_SENSITIVITY is comfortably
    // under.
    const rawValue = (fraction * 100) / this.meterScale;
    const clamped = Math.min(MAX_SENSITIVITY, Math.max(MIN_SENSITIVITY, rawValue));
    const stepped = Math.round(clamped / SENSITIVITY_STEP) * SENSITIVITY_STEP;
    const rounded = Math.round(stepped * 1000) / 1000;

    this.settingsService.update({ micSensitivity: rounded });
    this.soundTrigger.setThreshold(rounded);
  }
}
