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

  /** The longest clip's duration - the scrub slider's range, and the shared "session timeline"
   *  every clip is positioned against (see playFrom()/seekTo()). */
  protected readonly timelineDuration = signal(0);
  /** Current position on that shared timeline, in seconds. Driven by the longest clip's own
   *  currentTime while playing (see setupTimelineTracking()), since that clip always starts at
   *  session time 0 with no delay - and set directly while the user is scrubbing or restarting. */
  protected readonly timelinePosition = signal(0);
  /** Each clip's own real duration, in clipSet.clips order - shown next to its device label. */
  protected readonly clipDurations = signal<number[]>([]);

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

  /** Resumes from wherever the shared timeline currently sits (e.g. after a pause or a scrub). */
  protected playAll(): void {
    this.playFrom(this.timelinePosition());
  }

  protected pauseAll(): void {
    this.clearPendingStartTimers();
    this.isPlaying.set(false);
    for (const ref of this.videoRefs()) ref.nativeElement.pause();
  }

  protected restartAll(): void {
    this.playFrom(0);
  }

  /** Scrub slider handler - pauses (scrubbing while playing would otherwise fight the slider's
   *  own timeupdate-driven updates) and repositions every clip to the dragged-to timeline point. */
  protected onScrubInput(event: Event): void {
    if (!this.clipsReady()) return;
    const value = Number((event.target as HTMLInputElement).value);
    this.pauseAll();
    this.timelinePosition.set(value);
    this.seekTo(value);
  }

  protected cancelAutoReturn(): void {
    this.autoReturnCancelled.set(true);
  }

  protected loopsConfigured(): number {
    return this.settingsService.settings().autoReturnLoops;
  }

  protected formatTime(seconds: number): string {
    return `${(isFinite(seconds) && seconds > 0 ? seconds : 0).toFixed(1)}s`;
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
    this.setupTimelineTracking();
    this.clipDurations.set(this.durationsAndMax().durations);
    this.clipsReady.set(true);
    this.playFrom(0);
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

  /** Every clip's real duration, and the longest one - the shared "session timeline" length. */
  private durationsAndMax(): { videos: HTMLVideoElement[]; durations: number[]; maxDuration: number } {
    const videos = this.videoRefs().map((ref) => ref.nativeElement);
    const durations = videos.map((v) => (isFinite(v.duration) && v.duration > 0 ? v.duration : 0));
    const maxDuration = Math.max(...durations, 0);
    return { videos, durations, maxDuration };
  }

  /** How far into the shared timeline a clip of this duration starts, when sync is enabled -
   *  0 for the longest clip (and always, when sync is off), matching playFrom()/seekTo(). */
  private startDelaySeconds(duration: number, maxDuration: number, clipCount: number): number {
    const sync = this.settingsService.settings().syncClipEnds;
    return sync && clipCount > 1 ? Math.max(0, maxDuration - duration) : 0;
  }

  /** Starts (or resumes) playback from a given point on the shared timeline. A clip whose
   *  synced start delay hasn't been reached yet is positioned at its own 0 and scheduled to
   *  start once the remaining delay elapses, exactly as a fresh playFrom(0) does. */
  private playFrom(sessionSeconds: number): void {
    if (!this.clipsReady()) return;
    this.clearPendingStartTimers();
    this.applyRates();
    this.isPlaying.set(true);
    this.timelinePosition.set(sessionSeconds);

    const { videos, durations, maxDuration } = this.durationsAndMax();
    const rate = this.playbackRate();
    videos.forEach((video, i) => {
      const duration = durations[i] || maxDuration;
      const delaySec = this.startDelaySeconds(duration, maxDuration, videos.length);
      const remainingDelaySec = delaySec - sessionSeconds;
      if (remainingDelaySec <= 0) {
        video.currentTime = Math.min(Math.max(sessionSeconds - delaySec, 0), duration);
        void video.play();
      } else {
        video.currentTime = 0;
        this.pendingStartTimers.push(setTimeout(() => void video.play(), (remainingDelaySec / rate) * 1000));
      }
    });
  }

  /** Repositions every clip to a point on the shared timeline without playing - used while
   *  the user drags the scrub slider. */
  private seekTo(sessionSeconds: number): void {
    const { videos, durations, maxDuration } = this.durationsAndMax();
    videos.forEach((video, i) => {
      const duration = durations[i] || maxDuration;
      const delaySec = this.startDelaySeconds(duration, maxDuration, videos.length);
      video.currentTime = Math.min(Math.max(sessionSeconds - delaySec, 0), duration);
    });
  }

  /** Drives the scrub slider's range/position from the longest clip - the one clip that always
   *  starts at shared-timeline 0 with no delay, whether sync is on or off (see startDelaySeconds()). */
  private setupTimelineTracking(): void {
    const { videos, durations, maxDuration } = this.durationsAndMax();
    this.timelineDuration.set(maxDuration);
    this.timelinePosition.set(0);
    const referenceIndex = durations.indexOf(maxDuration);
    const reference = videos[referenceIndex];
    if (!reference) return;
    reference.ontimeupdate = () => this.timelinePosition.set(reference.currentTime);
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
