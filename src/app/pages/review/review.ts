import { Component, ElementRef, effect, inject, signal, viewChildren } from '@angular/core';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { ClipStoreService, StoredClip } from '../../services/clip-store.service';
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
  private readonly router = inject(Router);

  protected readonly videoRefs = viewChildren<ElementRef<HTMLVideoElement>>('player');
  protected readonly playbackRate = signal(1);
  protected readonly isPlaying = signal(false);
  /** True once every clip's real duration is known - only then is autoplay/manual play allowed to start. */
  protected readonly clipsReady = signal(false);
  protected readonly autoReturnCancelled = signal(false);
  protected readonly loopsCompleted = signal(0);

  /** Bumped for every new clip set so a slow in-flight prepare() for a stale set can detect it's obsolete and stop. */
  private generation = 0;
  private endedIndices = new Set<number>();
  private pendingStartTimers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    effect(() => {
      const clipSet = this.clipStore.clipSet();
      const videos = this.videoRefs();
      if (!clipSet || videos.length === 0 || videos.length !== clipSet.clips.length) return;

      const generation = ++this.generation;
      this.clearPendingStartTimers();
      this.clipsReady.set(false);
      this.isPlaying.set(false);
      this.autoReturnCancelled.set(false);
      this.loopsCompleted.set(0);
      void this.prepare(generation);
    });
  }

  protected onRateInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.playbackRate.set(value);
    this.applyRates();
  }

  protected playAll(): void {
    if (!this.clipsReady()) return;
    this.clearPendingStartTimers();
    this.applyRates();
    this.isPlaying.set(true);

    const videos = this.videoRefs().map((ref) => ref.nativeElement);
    const rate = this.playbackRate();
    const sync = this.settingsService.settings().syncClipEnds;
    if (!sync || videos.length <= 1) {
      for (const video of videos) void video.play();
      return;
    }

    const durations = videos.map((v) => (isFinite(v.duration) && v.duration > 0 ? v.duration : 0));
    const maxDuration = Math.max(...durations, 0);
    videos.forEach((video, i) => {
      const duration = durations[i] || maxDuration;
      const delayMs = maxDuration > 0 ? ((maxDuration - duration) / rate) * 1000 : 0;
      if (delayMs <= 0) {
        void video.play();
      } else {
        this.pendingStartTimers.push(setTimeout(() => void video.play(), delayMs));
      }
    });
  }

  protected pauseAll(): void {
    this.clearPendingStartTimers();
    this.isPlaying.set(false);
    for (const ref of this.videoRefs()) ref.nativeElement.pause();
  }

  protected restartAll(): void {
    this.clearPendingStartTimers();
    for (const ref of this.videoRefs()) ref.nativeElement.currentTime = 0;
    this.playAll();
  }

  protected cancelAutoReturn(): void {
    this.autoReturnCancelled.set(true);
  }

  protected loopsConfigured(): number {
    return this.settingsService.settings().autoReturnLoops;
  }

  protected downloadFilename(clip: StoredClip, index: number): string {
    const ext = clip.mimeType.includes('mp4') ? 'mp4' : 'webm';
    const safeLabel =
      clip.deviceLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || `clip-${index + 1}`;
    return `archer-form-replay-${safeLabel}.${ext}`;
  }

  private async prepare(generation: number): Promise<void> {
    const videos = this.videoRefs().map((ref) => ref.nativeElement);
    await Promise.all(videos.map((video) => this.waitForDuration(video)));
    if (generation !== this.generation) return; // a newer clip set has since arrived

    this.applyRates();
    this.setupEndedListeners(generation);
    this.clipsReady.set(true);

    const delaySeconds = this.settingsService.settings().autoplayDelaySeconds;
    if (delaySeconds <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    if (generation !== this.generation) return;
    this.playAll();
  }

  /** Resolves once `video.duration` is a real finite number. MediaRecorder's raw streaming
   *  output famously reports Infinity until you seek near the end once - only expected here if
   *  clip trimming failed and the untrimmed fallback capture was used. */
  private waitForDuration(video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      const onLoaded = () => {
        if (isFinite(video.duration) && video.duration > 0) {
          finish();
          return;
        }
        const restore = video.currentTime;
        video.addEventListener(
          'seeked',
          () => {
            video.currentTime = restore;
            finish();
          },
          { once: true },
        );
        video.currentTime = 1e9;
      };

      if (video.readyState >= 1 && isFinite(video.duration) && video.duration > 0) {
        finish();
      } else {
        video.addEventListener('loadedmetadata', onLoaded);
        setTimeout(finish, 6_000); // never block forever if metadata never loads
      }
    });
  }

  private applyRates(): void {
    const rate = this.playbackRate();
    for (const ref of this.videoRefs()) ref.nativeElement.playbackRate = rate;
  }

  private clearPendingStartTimers(): void {
    for (const timer of this.pendingStartTimers) clearTimeout(timer);
    this.pendingStartTimers = [];
  }

  private setupEndedListeners(generation: number): void {
    const videos = this.videoRefs();
    this.endedIndices.clear();
    videos.forEach((ref, i) => {
      ref.nativeElement.onended = () => {
        if (generation !== this.generation) return;
        this.endedIndices.add(i);
        if (this.endedIndices.size >= videos.length) {
          this.endedIndices.clear();
          this.isPlaying.set(false);
          this.handleRoundComplete();
        }
      };
    });
  }

  private handleRoundComplete(): void {
    const limit = this.loopsConfigured();
    if (limit <= 0 || this.autoReturnCancelled()) return;

    const next = this.loopsCompleted() + 1;
    this.loopsCompleted.set(next);
    if (next >= limit) {
      void this.router.navigate(['/record']);
    } else {
      this.restartAll();
    }
  }
}
