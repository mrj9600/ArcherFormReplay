import { Injectable, inject, signal } from '@angular/core';
import { pickSupportedMimeType } from './media-format';
import { trimClip } from './clip-trimmer';
import { FrameRecorder, RecorderStats, TimingSource } from './frame-recorder';
import type { ClipDebug } from './session-protocol';
import { SettingsService } from './settings.service';
import { epochNow } from './time';

/** Extra footage recorded past the end of the requested clip window before cutting, so the
 *  window's end is always comfortably inside data the recorder has actually flushed - encoders lag
 *  the live stream by some frames, and cutting right at the edge risks a clip that's slightly
 *  short at the end. */
const TAIL_MARGIN_MS = 500;

export interface ExtractClipHooks {
  /** Called once the footage for the window has been captured, right before it's cut into a
   *  clip - the recorder is no longer needed after this point. */
  onClipping?: () => void;
}

export interface ExtractedClip {
  blob: Blob;
  /** Epoch ms (this device's clock) of the clip's first frame - exact for precise capture, null
   *  for the MediaRecorder fallback, whose trimmed start can't be tied to a moment that closely. */
  startEpochMs: number | null;
  /** Timing debug numbers about how this clip was cut. */
  debug: ClipDebug;
}

/** How this device is timing its footage: 'capture-time' and 'smoothed-arrival' are the precise
 *  frame recorder (see TimingSource); 'basic' is the MediaRecorder fallback. */
export type RecorderTiming = TimingSource | 'basic';

/**
 * Records the camera from start() until stop(), and cuts a clip around a trigger time on demand.
 * Callers start it when a shot is about to be possible and stop it once the clip has been captured,
 * so history (and cutting cost) stays short.
 *
 * Preferred: FrameRecorder (WebCodecs) - every frame is stamped with the epoch time it was
 * captured at, and clips are cut on exact frame boundaries. Fallback, where that isn't available
 * or is turned off: a single MediaRecorder run trimmed with mediabunny, whose recording start
 * can only be located to within a frame or two.
 *
 * All timestamps are on the epoch clock (time.ts).
 */
@Injectable({ providedIn: 'root' })
export class RollingBufferRecorderService {
  private readonly settingsService = inject(SettingsService);

  readonly isRecording = signal(false);
  readonly mimeTypeUsed = signal('');
  /** How the current recording is being timed, once known (null when not recording). */
  readonly timing = signal<RecorderTiming | null>(null);
  /** Which recorder is in use: the precise frame recorder, or the plain MediaRecorder fallback. */
  readonly mode = signal<'precise' | 'media-recorder' | null>(null);
  /** Why the MediaRecorder fallback is in use, when it is. */
  readonly fallbackReason = signal('');
  /** Live recorder numbers for the timing debug readout (precise capture only), refreshed twice a second. */
  readonly stats = signal<RecorderStats | null>(null);

  private frameRecorder: FrameRecorder | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  private recorder: MediaRecorder | null = null;
  private mimeType = '';
  private chunks: Blob[] = [];
  /** MediaRecorder fallback only: epoch ms at which the current recording began. */
  private recordingStartedAt = 0;

  start(stream: MediaStream): void {
    this.stop();
    this.isRecording.set(true);
    this.fallbackReason.set('');

    if (!this.settingsService.settings().preciseCapture) {
      this.fallbackReason.set('precise capture is turned off in Settings');
    } else if (!FrameRecorder.isSupported()) {
      this.fallbackReason.set('this browser has no WebCodecs/MediaStreamTrackProcessor');
    }

    if (!this.fallbackReason()) {
      const frameRecorder = new FrameRecorder();
      this.frameRecorder = frameRecorder;
      this.mode.set('precise');
      frameRecorder.start(stream, () => this.settingsService.settings().videoTimingOffsetMs);
      this.statsTimer = setInterval(() => this.stats.set(frameRecorder.getStats()), 500);
      void frameRecorder.ready.then((ok) => {
        if (this.frameRecorder !== frameRecorder) return; // stopped or restarted meanwhile
        if (ok) {
          this.mimeTypeUsed.set(frameRecorder.mimeType);
          this.timing.set(frameRecorder.timingSource ?? 'smoothed-arrival');
        } else {
          // This device can't do precise capture (no encoder for it, etc.) - fall back rather
          // than leave it unable to record at all.
          this.frameRecorder = null;
          frameRecorder.stop();
          this.fallbackReason.set('precise capture failed to start on this device (no usable encoder?)');
          this.startMediaRecorder(stream);
        }
      });
      return;
    }
    this.startMediaRecorder(stream);
  }

  stop(): void {
    this.frameRecorder?.stop();
    this.frameRecorder = null;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.stats.set(null);
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null;
      this.recorder.onstart = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
    this.isRecording.set(false);
    this.timing.set(null);
    this.mode.set(null);
  }

  /**
   * Waits until the post-roll after the trigger has actually been recorded, then cuts the
   * recording down to [trigger - preRollSeconds, trigger + postRollSeconds]. `triggerTimestamp` is
   * on the epoch clock. If the recording hadn't been running long enough to have that much pre-roll
   * yet, the clip starts as early as it can rather than failing - shorter than requested, never
   * corrupted.
   */
  async extractClip(
    triggerTimestamp: number,
    preRollSeconds: number,
    postRollSeconds: number,
    hooks: ExtractClipHooks = {},
  ): Promise<ExtractedClip> {
    const windowStart = triggerTimestamp - preRollSeconds * 1000;
    const windowEnd = triggerTimestamp + postRollSeconds * 1000;

    if (this.frameRecorder) {
      const clip = await this.frameRecorder.extract(windowStart, windowEnd, hooks.onClipping);
      this.mimeTypeUsed.set(clip.blob.type);
      return { blob: clip.blob, startEpochMs: clip.startEpochMs, debug: { mode: 'precise (WebCodecs)', ...clip.debug } as unknown as ClipDebug };
    }
    return this.extractWithMediaRecorder(windowStart, windowEnd, hooks);
  }

  private startMediaRecorder(stream: MediaStream): void {
    this.mimeType = pickSupportedMimeType();
    this.mimeTypeUsed.set(this.mimeType || 'video/webm');
    this.chunks = [];
    // Provisional value in case 'start' never fires before an early extractClip(); replaced with
    // the real moment as soon as the recorder reports it.
    this.recordingStartedAt = epochNow();

    const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
    const recorder = new MediaRecorder(stream, options);
    this.recorder = recorder;
    recorder.onstart = () => {
      if (this.recorder === recorder) this.recordingStartedAt = epochNow();
    };
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    // No timeslice: data only flushes to ondataavailable when we explicitly call
    // requestData() (see flush()) or on stop() - nothing to do in the idle case in between.
    recorder.start();
    this.mode.set('media-recorder');
    this.timing.set('basic');
  }

  private async extractWithMediaRecorder(
    windowStart: number,
    windowEnd: number,
    hooks: ExtractClipHooks,
  ): Promise<ExtractedClip> {
    const waitMs = windowEnd + TAIL_MARGIN_MS - epochNow();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    await this.flush();

    const mimeType = this.mimeType || 'video/webm';
    const fullBlob = new Blob(this.chunks, { type: mimeType });
    const startSec = Math.max(0, (windowStart - this.recordingStartedAt) / 1000);
    const endSec = Math.max(startSec + 0.05, (windowEnd - this.recordingStartedAt) / 1000);

    hooks.onClipping?.();

    try {
      // A hard timeout, not just a try/catch: a trim that hangs (rather than rejects) would
      // otherwise leave the caller awaiting forever, stuck in "clipping" indefinitely.
      const blob = await Promise.race([
        trimClip(fullBlob, startSec, endSec, mimeType),
        new Promise<Blob>((_, reject) => setTimeout(() => reject(new Error('Clip trim timed out')), 20_000)),
      ]);
      return { blob, startEpochMs: null, debug: { mode: 'MediaRecorder', timing: 'basic', trimmed: 'yes' } };
    } catch (err) {
      console.error('Clip trim failed, using untrimmed capture instead', err);
      return { blob: fullBlob, startEpochMs: null, debug: { mode: 'MediaRecorder', timing: 'basic', trimmed: 'FAILED (untrimmed)' } };
    }
  }

  /** Flushes everything captured so far into `this.chunks` without stopping the recording. */
  private flush(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== 'recording') return Promise.resolve();
    return new Promise((resolve) => {
      const onData = () => {
        recorder.removeEventListener('dataavailable', onData);
        resolve();
      };
      recorder.addEventListener('dataavailable', onData);
      recorder.requestData();
    });
  }
}
