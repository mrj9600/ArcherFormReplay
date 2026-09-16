import { Component, ElementRef, effect, inject, signal, viewChildren } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { ClipStoreService } from '../../services/clip-store.service';
import { SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-review',
  imports: [MatIconModule, MatButtonModule],
  templateUrl: './review.html',
  styleUrl: './review.scss',
})
export class Review {
  protected readonly clipStore = inject(ClipStoreService);
  protected readonly settingsService = inject(SettingsService);
  protected readonly videoRefs = viewChildren<ElementRef<HTMLVideoElement>>('player');
  protected readonly playbackRate = signal(1);

  constructor() {
    // Auto-plays a freshly captured clip set after the configured delay, once the <video> elements exist for it.
    effect((onCleanup) => {
      const clipSet = this.clipStore.clipSet();
      const videos = this.videoRefs();
      if (!clipSet || videos.length === 0) return;

      const delaySeconds = this.settingsService.settings().autoplayDelaySeconds;
      if (delaySeconds <= 0) return;

      const handle = setTimeout(() => this.playAll(), delaySeconds * 1000);
      onCleanup(() => clearTimeout(handle));
    });
  }

  protected onRateInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.playbackRate.set(value);
    for (const ref of this.videoRefs()) {
      ref.nativeElement.playbackRate = value;
    }
  }

  protected playAll(): void {
    for (const ref of this.videoRefs()) {
      ref.nativeElement.playbackRate = this.playbackRate();
      void ref.nativeElement.play();
    }
  }

  protected pauseAll(): void {
    for (const ref of this.videoRefs()) {
      ref.nativeElement.pause();
    }
  }
}
