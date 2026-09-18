import { Injectable, signal } from '@angular/core';
import { pickSupportedMimeType } from './media-format';
import { trimClip } from './clip-trimmer';
import { epochNow } from './time';

/** Extra footage recorded past the end of the requested clip window before cutting, so the
 *  window's end is always comfortably inside data the encoder has actually flushed - encoders lag
 *  the live stream by some frames, and cutting right at the edge risks a clip that's slightly
 *  short at the end. */
const TAIL_MARGIN_MS = 500;

export interface ExtractClipHooks {
  /** Called once the footage for the window has been captured and flushed, right before the
   *  (potentially slow) trim starts - the recorder is no longer needed after this point. */
  onClipping?: () => void;
}

/**
 * Records continuously from start() in a single MediaRecorder run (no periodic restarts) so a
 * clip can be extracted spanning from *before* a trigger to *after* it. Callers start it when a
 * shot is about to be possible and stop it once the clip has been captured - restarting it per
 * shot keeps the history (and therefore the trim cost) short, instead of letting one recording
 * grow for a whole session.
 *
 * Every timestamp here is on the epoch clock (time.ts): the moment recording actually began is
 * captured when the recorder reports it started, and a trigger's time is compared against that to
 * find where in the recording it falls - the container's own timeline starts at 0 at that moment.
 *
 * MediaRecorder is started without a timeslice, so it only hands over data when explicitly asked
 * via requestData() - extractClip() does that on demand, then hands the recording so far (one
 * continuous, always-valid container) to clip-trimmer.ts, which uses mediabunny (WebCodecs) to cut
 * the exact [start, end) window out of it.
 */
@Injectable({ providedIn: 'root' })
export class RollingBufferRecorderService {
  readonly isRecording = signal(false);
  readonly mimeTypeUsed = signal('');

  private recorder: MediaRecorder | null = null;
  private mimeType = '';
  private chunks: Blob[] = [];
  /** Epoch ms at which the current recording began. */
  private recordingStartedAt = 0;

  start(stream: MediaStream): void {
    this.stop();
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
    this.isRecording.set(true);
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null;
      this.recorder.onstart = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
    this.isRecording.set(false);
  }

  /**
   * Waits until postRollSeconds (plus a small safety margin) after the trigger has actually been
   * recorded, then trims the recording so far down to exactly
   * [trigger - preRollSeconds, trigger + postRollSeconds]. `triggerTimestamp` is on the epoch
   * clock. If the recording hadn't been running long enough to have that much pre-roll yet, the
   * clip starts as early as it can rather than failing - shorter than requested, never corrupted.
   */
  async extractClip(
    triggerTimestamp: number,
    preRollSeconds: number,
    postRollSeconds: number,
    hooks: ExtractClipHooks = {},
  ): Promise<Blob> {
    const windowStart = triggerTimestamp - preRollSeconds * 1000;
    const windowEnd = triggerTimestamp + postRollSeconds * 1000;

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
      return await Promise.race([
        trimClip(fullBlob, startSec, endSec, mimeType),
        new Promise<Blob>((_, reject) => setTimeout(() => reject(new Error('Clip trim timed out')), 20_000)),
      ]);
    } catch (err) {
      console.error('Clip trim failed, using untrimmed capture instead', err);
      return fullBlob;
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
