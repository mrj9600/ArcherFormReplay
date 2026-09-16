import { Injectable, signal } from '@angular/core';
import { pickSupportedMimeType } from './media-format';

interface BufferChunk {
  blob: Blob;
  /** performance.now() timestamp when this chunk was received. */
  timestamp: number;
}

/**
 * Records continuously in small timeslices and keeps a rolling window of recent chunks so a
 * clip can be extracted spanning from *before* a trigger to *after* it.
 *
 * WebM/MP4 chunks from MediaRecorder aren't self-contained after the first one - only the
 * (header + subsequent chunks) of the *same* recording segment concatenate into a playable
 * file. So instead of trimming an ever-growing single recording, the recorder is restarted
 * into a fresh segment right after each clip is extracted (shots are seconds apart, so the
 * next trigger's pre-roll window is comfortably inside the new segment by then), plus an
 * idle safety restart if the app has been armed for a while without a trigger, so memory
 * doesn't grow unbounded and the header segment doesn't get too old.
 */
@Injectable({ providedIn: 'root' })
export class RollingBufferRecorderService {
  readonly isRecording = signal(false);
  readonly mimeTypeUsed = signal('');

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private mimeType = '';
  private chunkMs = 250;
  private header: BufferChunk | null = null;
  private chunks: BufferChunk[] = [];
  private segmentStartedAt = 0;
  private idleRestartHandle: ReturnType<typeof setInterval> | null = null;
  private pendingCaptureUntil = 0;

  private readonly retentionMs = 20_000;
  private readonly idleRestartCheckMs = 5_000;
  private readonly idleRestartAfterMs = 60_000;

  start(stream: MediaStream, chunkMs = 250): void {
    this.stop();
    this.stream = stream;
    this.chunkMs = chunkMs;
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
   * Waits until postRollSeconds after the trigger has actually been recorded, then slices out
   * [trigger - preRollSeconds, trigger + postRollSeconds] as a playable Blob.
   */
  async extractClip(
    triggerTimestamp: number,
    preRollSeconds: number,
    postRollSeconds: number,
  ): Promise<Blob> {
    const preRollMs = preRollSeconds * 1000;
    const postRollMs = postRollSeconds * 1000;
    const windowStart = triggerTimestamp - preRollMs;
    const windowEnd = triggerTimestamp + postRollMs;

    this.pendingCaptureUntil = windowEnd + 500;
    const waitMs = windowEnd - performance.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs + this.chunkMs));
    }

    const selected = this.chunks.filter(
      (chunk) => chunk.timestamp >= windowStart && chunk.timestamp <= windowEnd + this.chunkMs,
    );
    const parts = this.header ? [this.header.blob, ...selected.map((c) => c.blob)] : selected.map((c) => c.blob);
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
        this.pruneOldChunks();
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

  private pruneOldChunks(): void {
    const cutoff = performance.now() - this.retentionMs;
    while (this.chunks.length && this.chunks[0].timestamp < cutoff) {
      this.chunks.shift();
    }
  }
}
