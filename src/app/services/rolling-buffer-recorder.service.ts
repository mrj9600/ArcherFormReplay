import { Injectable, signal } from '@angular/core';
import { pickSupportedMimeType } from './media-format';
import { trimClip } from './clip-trimmer';

/**
 * Records continuously for the whole session in a single MediaRecorder run (no periodic
 * restarts) so a clip can be extracted spanning from *before* a trigger to *after* it.
 *
 * MediaRecorder is started without a timeslice, so it only hands over data when explicitly asked
 * via requestData() - extractClip() does that on demand, then hands the *entire* recording so far
 * (one continuous, always-valid container: a single header plus every chunk since start()) to
 * clip-trimmer.ts, which uses mediabunny (WebCodecs) to cut the exact [start, end) window out of
 * it. Because the whole history is always a single valid stream, there's no chunk-boundary/
 * keyframe-chain corruption risk to work around - trimming can start anywhere, not just at a
 * segment restart boundary.
 *
 * Trade-off: unlike a segmented design, the buffered chunks (and the blob rebuilt from them on
 * every extractClip() call) grow for as long as recording runs, and mediabunny has to seek/decode
 * through more history as a session goes on. For a typical archery session length this is a
 * reasonable trade for avoiding the restart-boundary complexity and its failure modes.
 */
@Injectable({ providedIn: 'root' })
export class RollingBufferRecorderService {
  readonly isRecording = signal(false);
  readonly mimeTypeUsed = signal('');

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private mimeType = '';
  private chunks: Blob[] = [];
  private recordingStartedAt = 0;

  start(stream: MediaStream): void {
    this.stop();
    this.stream = stream;
    this.mimeType = pickSupportedMimeType();
    this.mimeTypeUsed.set(this.mimeType || 'video/webm');
    this.chunks = [];
    this.recordingStartedAt = performance.now();

    const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
    this.recorder = new MediaRecorder(stream, options);
    this.recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    // No timeslice: data only flushes to ondataavailable when we explicitly call
    // requestData() (see flush()) or on stop() - nothing to do in the idle case in between.
    this.recorder.start();
    this.isRecording.set(true);
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.isRecording.set(false);
  }

  /**
   * Waits until postRollSeconds after the trigger has actually been recorded, then trims the
   * full recording-so-far down to exactly [trigger - preRollSeconds, trigger + postRollSeconds].
   * If the recording hasn't been running long enough to have that much pre-roll history yet, the
   * clip starts as early as it can rather than failing - shorter than requested, never corrupted.
   */
  async extractClip(triggerTimestamp: number, preRollSeconds: number, postRollSeconds: number): Promise<Blob> {
    const windowStart = triggerTimestamp - preRollSeconds * 1000;
    const windowEnd = triggerTimestamp + postRollSeconds * 1000;

    const waitMs = windowEnd - performance.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    await this.flush();

    const mimeType = this.mimeType || 'video/webm';
    const fullBlob = new Blob(this.chunks, { type: mimeType });
    const startSec = Math.max(0, (windowStart - this.recordingStartedAt) / 1000);
    const endSec = Math.max(startSec + 0.05, (windowEnd - this.recordingStartedAt) / 1000);

    try {
      // A hard timeout, not just a try/catch: a trim that hangs (rather than rejects) would
      // otherwise leave the caller awaiting forever, stuck in "capturing" indefinitely.
      return await Promise.race([
        trimClip(fullBlob, startSec, endSec, mimeType),
        new Promise<Blob>((_, reject) => setTimeout(() => reject(new Error('Clip trim timed out')), 8_000)),
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
