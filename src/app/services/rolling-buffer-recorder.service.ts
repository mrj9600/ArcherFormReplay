import { Injectable, signal } from '@angular/core';
import { pickSupportedMimeType } from './media-format';

interface BufferChunk {
  blob: Blob;
  /** performance.now() timestamp when this chunk was received. */
  timestamp: number;
}

/**
 * Records continuously in small timeslices so a clip can be extracted spanning from *before* a
 * trigger to *after* it.
 *
 * A clip is built as [segment header, ...every chunk from the segment's start through the
 * trigger's end] - never a chunk range that *skips* the earlier part of the segment. Video
 * codecs encode most frames as deltas against earlier reference frames, so a clip built from a
 * header plus only a late slice of chunks (the segment's real start through some `windowStart`
 * cut, then jumping to chunks near the trigger) throws away the frames those later chunks
 * depend on - the result decodes as corrupted/frozen/laggy video. Concatenating multiple
 * *separate* complete recordings back to back doesn't work either: a `<video>` element only
 * plays through the first one's data, ignoring anything appended after it.
 *
 * So instead, each capture always spans from the current segment's true start. To keep that
 * from meaning "the whole recording so far", the segment is restarted regularly (idle timer)
 * and immediately after every capture, bounding how much extra footage a clip can carry before
 * the part the user actually wanted.
 */
@Injectable({ providedIn: 'root' })
export class RollingBufferRecorderService {
  readonly isRecording = signal(false);
  readonly mimeTypeUsed = signal('');

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private mimeType = '';
  private readonly chunkMs = 250;
  private header: BufferChunk | null = null;
  private chunks: BufferChunk[] = [];
  private idleRestartHandle: ReturnType<typeof setInterval> | null = null;
  private segmentStartedAt = 0;
  private pendingCaptureUntil = 0;

  private readonly idleRestartCheckMs = 3_000;
  /** Roughly the largest configurable pre-roll, so segments rarely need to be older than that. */
  private readonly idleRestartAfterMs = 10_000;

  start(stream: MediaStream): void {
    this.stop();
    this.stream = stream;
    this.mimeType = pickSupportedMimeType();
    this.mimeTypeUsed.set(this.mimeType || 'video/webm');
    this.beginSegment();
    this.isRecording.set(true);
    this.idleRestartHandle = setInterval(() => this.maybeIdleRestart(), this.idleRestartCheckMs);
  }

  stop(): void {
    if (this.idleRestartHandle) {
      clearInterval(this.idleRestartHandle);
      this.idleRestartHandle = null;
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.stream = null;
    this.header = null;
    this.chunks = [];
    this.isRecording.set(false);
  }

  /**
   * Waits until postRollSeconds after the trigger has actually been recorded, then returns
   * everything captured in the current segment up to that point as a playable Blob. The clip
   * may carry more pre-roll footage than `preRollSeconds` asked for (whatever the segment had),
   * but never less, and it's always a valid, continuous, correctly-decoding recording.
   */
  async extractClip(triggerTimestamp: number, preRollSeconds: number, postRollSeconds: number): Promise<Blob> {
    const windowEnd = triggerTimestamp + postRollSeconds * 1000;
    this.pendingCaptureUntil = windowEnd + 500;

    const waitMs = windowEnd - performance.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs + this.chunkMs));
    }

    const included = this.chunks.filter((chunk) => chunk.timestamp <= windowEnd + this.chunkMs);
    const parts = this.header ? [this.header.blob, ...included.map((c) => c.blob)] : included.map((c) => c.blob);
    const blob = new Blob(parts, { type: this.mimeType || 'video/webm' });

    this.restartSegment();
    return blob;
  }

  private beginSegment(): void {
    if (!this.stream) return;
    this.header = null;
    this.chunks = [];
    this.segmentStartedAt = performance.now();

    const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
    this.recorder = new MediaRecorder(this.stream, options);
    this.recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return;
      const chunk: BufferChunk = { blob: event.data, timestamp: performance.now() };
      if (!this.header) {
        this.header = chunk;
      } else {
        this.chunks.push(chunk);
      }
    };
    this.recorder.start(this.chunkMs);
  }

  private restartSegment(): void {
    if (!this.recorder || !this.stream) return;
    if (this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null;
      this.recorder.stop();
    }
    this.beginSegment();
  }

  private maybeIdleRestart(): void {
    if (!this.recorder || this.recorder.state !== 'recording') return;
    const now = performance.now();
    if (now < this.pendingCaptureUntil) return;
    if (now - this.segmentStartedAt >= this.idleRestartAfterMs) {
      this.restartSegment();
    }
  }
}
