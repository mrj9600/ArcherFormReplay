import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild, viewChildren } from '@angular/core';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { ClipStoreService, StoredClip } from '../../services/clip-store.service';
import { SettingsService } from '../../services/settings.service';

/** Video-vs-clock error beyond which a video is re-seeked instead of gently sped up/slowed down. */
const HARD_SEEK_THRESHOLD_SEC = 0.25;
/** Time constant (seconds) of the speed correction that pulls a drifting video back to the shared clock. */
const DRIFT_CORRECTION_SEC = 0.5;
/** Largest speed correction, as a fraction of the current playback rate. */
const MAX_RATE_CORRECTION = 0.15;

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
  protected readonly rateSelectRef = viewChild<ElementRef<HTMLSelectElement>>('rateSelect');
  protected readonly speedOptions = [0.1, 0.25, 0.5, 1, 2];
  protected readonly playbackRate = signal(1);
  protected readonly isPlaying = signal(false);
  /** True once every clip's real duration is known - only then is autoplay/manual play allowed to start. */
  protected readonly clipsReady = signal(false);
  protected readonly autoReturnCancelled = signal(false);
  protected readonly loopsCompleted = signal(0);

  /** The shared timeline's length: the latest any clip ends, counting each clip's start delay. */
  protected readonly timelineDuration = signal(0);
  /** Current position on the shared timeline, in seconds. While playing this is driven by the
   *  shared clock (see tick()), not by any one video, so no clip's own timing is trusted over another's. */
  protected readonly timelinePosition = signal(0);
  /** Each clip's own real duration, in clipSet.clips order - shown next to its device label. */
  protected readonly clipDurations = signal<number[]>([]);
  /** How far into the shared timeline each clip starts, in seconds (see computeDelays()). */
  protected readonly clipDelays = signal<number[]>([]);
  /** Each clip's own width/height ratio, in clipSet.clips order - sizes its tile to fit the
   *  actual footage instead of a fixed box with letterboxing, and lets several tiles sit
   *  side by side once each is only as wide as its own content needs. */
  protected readonly clipAspectRatios = signal<number[]>([]);

  /** How the clips were lined up, for the timing debug readout. */
  protected readonly alignmentMode = signal<'off' | 'frame-timestamps' | 'ends'>('off');
  /** Timing debug: each playing video's error against the shared clock, in ms (+ = video ahead), refreshed ~4x/s. */
  protected readonly driftMs = signal<number[]>([]);

  protected readonly debugRows = computed(() => {
    const clipSet = this.clipStore.clipSet();
    if (!clipSet) return [];
    const durations = this.clipDurations();
    const delays = this.clipDelays();
    const drifts = this.driftMs();
    const starts = clipSet.clips.map((c) => c.startEpochMs);
    const earliest = starts.every((s) => s !== null) ? Math.min(...(starts as number[])) : null;
    const rows: { key: string; value: string }[] = [{ key: 'Alignment', value: this.alignmentMode() }];
    clipSet.clips.forEach((clip, i) => {
      const parts = [
        `dur ${((durations[i] ?? 0) * 1000).toFixed(0)}ms`,
        `delay ${((delays[i] ?? 0) * 1000).toFixed(1)}ms`,
        earliest !== null && clip.startEpochMs !== null ? `start +${(clip.startEpochMs - earliest).toFixed(1)}ms` : 'start unknown',
        `drift ${drifts[i] !== undefined ? drifts[i].toFixed(1) : '-'}ms`,
      ];
      if (clip.debug) parts.push(...Object.entries(clip.debug).map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toFixed(2)) : v}`));
      rows.push({ key: clip.deviceLabel, value: parts.join(' | ') });
    });
    return rows;
  });

  /** Bumped for every new clip set so a slow in-flight prepare() for a stale set can detect it's obsolete and stop. */
  private generation = 0;
  /** Bumped by every play/pause/scrub so a play that was still waiting on its seeks can tell it was superseded. */
  private playToken = 0;
  private rafHandle: number | null = null;
  private clockBasePosition = 0;
  private clockBaseWall = 0;
  private lastDriftPublish = 0;

  constructor() {
    effect(() => {
      const clipSet = this.clipStore.clipSet();
      const videos = this.videoRefs();
      if (!clipSet || videos.length === 0 || videos.length !== clipSet.clips.length) return;

      const generation = ++this.generation;
      this.stopClock();
      this.clipsReady.set(false);
      this.isPlaying.set(false);
      this.autoReturnCancelled.set(false);
      this.loopsCompleted.set(0);
      void this.prepare(generation);
    });

    // A native <select>'s [value] binding can fail to take if it's applied before the browser
    // has matched it against a same-value <option> - here, before the @for-rendered <option>s
    // exist yet on the very first render - and Angular only re-applies the binding when the
    // *source* value changes, not retroactively once a matching option shows up. The visible
    // symptom: the dropdown shows the browser's fallback (whichever option sorts first) while
    // playbackRate - and therefore actual playback - is unaffected and still correct. Setting it
    // imperatively here instead, after the view (including the options) is guaranteed to exist,
    // sidesteps that ordering problem entirely.
    effect(() => {
      const select = this.rateSelectRef()?.nativeElement;
      const rate = this.playbackRate();
      if (!select) return;
      select.value = String(rate);
    });

    inject(DestroyRef).onDestroy(() => this.stopClock());
  }

  protected setPlaybackRate(rate: number): void {
    if (this.isPlaying()) {
      // Re-anchor the shared clock so the position doesn't jump when its speed changes.
      this.clockBasePosition = this.currentPosition();
      this.clockBaseWall = performance.now();
    }
    this.playbackRate.set(rate);
    if (!this.isPlaying()) this.applyRates();
  }

  protected onRateSelectChange(event: Event): void {
    this.setPlaybackRate(Number((event.target as HTMLSelectElement).value));
  }

  /** Resumes from wherever the shared timeline currently sits (e.g. after a pause or a scrub). */
  protected playAll(): void {
    void this.playFrom(this.timelinePosition());
  }

  protected pauseAll(): void {
    const position = this.currentPosition();
    this.playToken++;
    this.stopClock();
    this.isPlaying.set(false);
    for (const ref of this.videoRefs()) ref.nativeElement.pause();
    this.timelinePosition.set(position);
    // Pausing leaves each video wherever its own decoder happened to stop; re-seeking them all
    // to the exact shared position makes the paused frames line up.
    this.seekTo(position);
  }

  protected restartAll(): void {
    void this.playFrom(0);
  }

  /** Scrub slider handler - pauses (scrubbing while playing would otherwise fight the shared
   *  clock) and repositions every clip to the dragged-to timeline point. */
  protected onScrubInput(event: Event): void {
    if (!this.clipsReady()) return;
    const value = Number((event.target as HTMLInputElement).value);
    this.playToken++;
    this.stopClock();
    this.isPlaying.set(false);
    for (const ref of this.videoRefs()) ref.nativeElement.pause();
    this.timelinePosition.set(value);
    this.seekTo(value);
  }

  protected cancelAutoReturn(): void {
    this.autoReturnCancelled.set(true);
  }

  protected loopsConfigured(): number {
    return Math.max(0, this.settingsService.settings().autoReturnLoops);
  }

  protected formatTime(seconds: number): string {
    return `${(isFinite(seconds) && seconds > 0 ? seconds : 0).toFixed(1)}s`;
  }

  /** Falls back to a 16:9 guess before the real aspect ratio is known, so the tile reserves a
   *  reasonable shape immediately instead of jumping in size once metadata loads. */
  protected aspectRatioFor(index: number): number {
    return this.clipAspectRatios()[index] || 16 / 9;
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

  /** Downloads every clip in the current set. Staggered slightly - firing several downloads
   *  from a single click in the same tick makes some browsers silently drop all but the first. */
  protected downloadAll(): void {
    const clipSet = this.clipStore.clipSet();
    if (!clipSet) return;
    clipSet.clips.forEach((clip, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = clip.url;
        a.download = this.downloadFilename(clip, i);
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 200);
    });
  }

  private async prepare(generation: number): Promise<void> {
    const videos = this.videoRefs().map((ref) => ref.nativeElement);
    await Promise.all(videos.map((video) => this.waitForDuration(video)));
    if (generation !== this.generation) return; // a newer clip set has since arrived

    const { durations } = this.durationsAndMax();
    const delays = this.computeDelays(durations);
    this.clipDelays.set(delays);
    this.timelineDuration.set(Math.max(0, ...durations.map((d, i) => d + delays[i])));
    this.timelinePosition.set(0);
    this.applyRates();
    this.clipDurations.set(durations);
    this.clipAspectRatios.set(videos.map((v) => (v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 16 / 9)));
    this.clipsReady.set(true);
    void this.playFrom(0);
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

  /** Every clip's real duration, and the longest one. */
  private durationsAndMax(): { videos: HTMLVideoElement[]; durations: number[]; maxDuration: number } {
    const videos = this.videoRefs().map((ref) => ref.nativeElement);
    const durations = videos.map((v) => (isFinite(v.duration) && v.duration > 0 ? v.duration : 0));
    const maxDuration = Math.max(...durations, 0);
    return { videos, durations, maxDuration };
  }

  /**
   * How far into the shared timeline each clip starts. With sync on, clips whose real start times
   * are all known (precise capture) are placed by those times - so every camera shows the same
   * instant at the same timeline position. Otherwise it falls back to lining up the clips' ends,
   * which is only as good as their cut ends were. With sync off, every clip starts at 0.
   */
  private computeDelays(durations: number[]): number[] {
    const clips = this.clipStore.clipSet()?.clips ?? [];
    const zeros = durations.map(() => 0);
    if (!this.settingsService.settings().syncClipEnds || clips.length < 2) {
      this.alignmentMode.set('off');
      return zeros;
    }
    const starts = clips.map((c) => c.startEpochMs);
    if (starts.every((s): s is number => s !== null)) {
      const earliest = Math.min(...starts);
      this.alignmentMode.set('frame-timestamps');
      return starts.map((s) => (s - earliest) / 1000);
    }
    const max = Math.max(...durations, 0);
    this.alignmentMode.set('ends');
    return durations.map((d) => Math.max(0, max - (d || max)));
  }

  private currentPosition(): number {
    if (!this.isPlaying() || this.rafHandle === null) return this.timelinePosition();
    return this.clockBasePosition + ((performance.now() - this.clockBaseWall) / 1000) * this.playbackRate();
  }

  private stopClock(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  /** Repositions every clip to a point on the shared timeline without playing. */
  private seekTo(sessionSeconds: number): void {
    const { videos, durations } = this.durationsAndMax();
    const delays = this.clipDelays();
    videos.forEach((video, i) => {
      video.currentTime = Math.min(Math.max(sessionSeconds - (delays[i] ?? 0), 0), durations[i]);
    });
  }

  /** Like seekTo(), but resolves once every video has actually finished seeking - so playback can
   *  begin with all of them already in place instead of catching up afterwards. */
  private seekAndWait(sessionSeconds: number): Promise<void> {
    const { videos, durations } = this.durationsAndMax();
    const delays = this.clipDelays();
    return Promise.all(
      videos.map(
        (video, i) =>
          new Promise<void>((resolve) => {
            const target = Math.min(Math.max(sessionSeconds - (delays[i] ?? 0), 0), durations[i]);
            if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
              resolve();
              return;
            }
            const done = () => {
              video.removeEventListener('seeked', done);
              resolve();
            };
            video.addEventListener('seeked', done);
            setTimeout(done, 800);
            video.currentTime = target;
          }),
      ),
    ).then(() => undefined);
  }

  /**
   * Starts (or resumes) playback from a point on the shared timeline. All videos are first seeked
   * into place, then a single shared clock starts and every video is started against it; from then
   * on tick() keeps each one locked to that clock, since separately-started <video> elements
   * otherwise start with jitter and slowly drift apart.
   */
  private async playFrom(sessionSeconds: number): Promise<void> {
    if (!this.clipsReady()) return;
    const token = ++this.playToken;
    this.stopClock();
    this.applyRates();
    this.isPlaying.set(true);
    this.timelinePosition.set(sessionSeconds);

    await this.seekAndWait(sessionSeconds);
    if (token !== this.playToken) return; // paused, scrubbed or restarted while seeking

    this.clockBasePosition = sessionSeconds;
    this.clockBaseWall = performance.now();
    const { videos, durations } = this.durationsAndMax();
    const delays = this.clipDelays();
    videos.forEach((video, i) => {
      const target = sessionSeconds - (delays[i] ?? 0);
      if (target >= 0 && target < durations[i]) void video.play();
    });
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    if (!this.isPlaying()) {
      this.rafHandle = null;
      return;
    }
    const now = performance.now();
    const rate = this.playbackRate();
    const position = this.clockBasePosition + ((now - this.clockBaseWall) / 1000) * rate;
    const { videos, durations } = this.durationsAndMax();
    const delays = this.clipDelays();
    const total = this.timelineDuration();
    const drifts: number[] = [];

    videos.forEach((video, i) => {
      const target = position - (delays[i] ?? 0);
      const duration = durations[i];
      if (target < 0 || target >= duration) {
        // Not started yet, or already finished: hold still (on its first / last frame).
        if (!video.paused) video.pause();
        drifts.push(0);
        return;
      }
      if (video.paused) {
        // Just reached its start on the shared timeline.
        video.currentTime = target;
        video.playbackRate = rate;
        void video.play();
        drifts.push(0);
        return;
      }
      const error = video.currentTime - target; // + = this video is ahead of the shared clock
      drifts.push(error * 1000);
      if (Math.abs(error) > HARD_SEEK_THRESHOLD_SEC) {
        video.currentTime = target;
        video.playbackRate = rate;
      } else {
        const limit = MAX_RATE_CORRECTION * rate;
        video.playbackRate = rate + Math.min(limit, Math.max(-limit, -error / DRIFT_CORRECTION_SEC));
      }
    });

    this.timelinePosition.set(Math.min(position, total));
    if (now - this.lastDriftPublish > 250) {
      this.lastDriftPublish = now;
      this.driftMs.set(drifts);
    }

    if (position >= total) {
      this.rafHandle = null;
      this.isPlaying.set(false);
      for (const video of videos) video.pause();
      this.handleRoundComplete();
      return;
    }
    this.rafHandle = requestAnimationFrame(this.tick);
  };

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
