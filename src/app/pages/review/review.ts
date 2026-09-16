import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ClipStoreService } from '../../services/clip-store.service';

@Component({
  selector: 'app-review',
  imports: [MatIconModule],
  templateUrl: './review.html',
  styleUrl: './review.scss',
})
export class Review {
  protected readonly clipStore = inject(ClipStoreService);
  protected readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('player');
  protected readonly playbackRate = signal(1);

  protected onRateInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.playbackRate.set(value);
    const video = this.videoRef()?.nativeElement;
    if (video) {
      video.playbackRate = value;
    }
  }
}
