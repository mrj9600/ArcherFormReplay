import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ClipStoreService } from '../../services/clip-store.service';
import { SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-review',
  imports: [MatIconModule],
  templateUrl: './review.html',
  styleUrl: './review.scss',
})
export class Review {
  protected readonly clipStore = inject(ClipStoreService);
  protected readonly settingsService = inject(SettingsService);
  protected readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('player');
  protected readonly playbackRate = signal(1);

  constructor() {
    // Auto-plays a freshly captured clip after the configured delay, once the <video> element exists for it.
    effect((onCleanup) => {
      const clip = this.clipStore.clip();
      const video = this.videoRef()?.nativeElement;
      if (!clip || !video) return;

      const delaySeconds = this.settingsService.settings().autoplayDelaySeconds;
      if (delaySeconds <= 0) return;

      const handle = setTimeout(() => {
        video.playbackRate = this.playbackRate();
        void video.play();
      }, delaySeconds * 1000);
      onCleanup(() => clearTimeout(handle));
    });
  }

  protected onRateInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.playbackRate.set(value);
    const video = this.videoRef()?.nativeElement;
    if (video) {
      video.playbackRate = value;
    }
  }
}
