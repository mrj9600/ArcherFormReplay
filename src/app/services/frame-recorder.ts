import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, WebMOutputFormat } from 'mediabunny';
import type { VideoCodec } from 'mediabunny';
import { epochNow } from './time';

/** Not in TypeScript's DOM typings yet; supported by Chromium-based browsers. */
interface TrackProcessorLike {
  readable: ReadableStream<VideoFrame>;
}
declare const MediaStreamTrackProcessor: (new (init: { track: MediaStreamTrack }) => TrackProcessorLike) | undefined;

/** Where each frame's timestamp came from - the honest answer to "how accurate is this device's
 *  frame timing": 'capture-time' is the browser reporting when the camera actually captured the
 *  frame; 'smoothed-arrival' is estimated from when frames reach the page (jitter-free, but
 *  offset from true capture by the camera pipeline's minimum latency). */
export type TimingSource = 'capture-time' | 'smoothed-arrival';

/** Numbers about how a clip was made - shown in the timing debug readouts, not used by the app. */
export interface ClipDebugInfo {
  timing: string;
  frames: number;
  /** How much earlier than the requested window start the clip actually starts (keyframe boundary). */
  startLeadMs: number;
  /** How far the last frame is short of the requested window end (encoder lag). */
  endShortMs: number;
  waitedForEndMs: number;
  remuxMs: number;
  codec: string;
  size: string;
  fps: number;
}

export interface FrameClip {
  blob: Blob;
  /** Epoch ms (this device's clock) of the clip's first frame. */
  startEpochMs: number;
  debug: ClipDebugInfo;
}

/** Live recorder numbers for the timing debug readout. */
export interface RecorderStats {
  timing: TimingSource | null;
  codec: string;
  size: string;
  fps: number;
  framesIn: number;
  framesDropped: number;
  bufferedFrames: number;
  bufferedSeconds: number;
  intervalMeanMs: number;
  /** Largest deviation of any recent frame interval from the mean - camera/pipeline timing jitter. */
  intervalMaxDevMs: number;
  /** Arrival-time timing only: spread (max - min) of recent frame arrival delays - the jitter that smoothing removes. */
  arrivalJitterMs: number | null;
}

interface CodecChoice {
  codec: string;
  mediabunnyCodec: VideoCodec;
  container: 'mp4' | 'webm';
  extra: Partial<VideoEncoderConfig>;
}

/** In order of preference: H.264 in MP4 plays everywhere (phone galleries included); VP9/VP8 in
 *  WebM cover browsers whose encoder lacks H.264. */
const CODEC_CHOICES: CodecChoice[] = [
  { codec: 'avc1.64002A', mediabunnyCodec: 'avc', container: 'mp4', extra: { avc: { format: 'avc' } } },
  { codec: 'avc1.4D002A', mediabunnyCodec: 'avc', container: 'mp4', extra: { avc: { format: 'avc' } } },
  { codec: 'avc1.42E02A', mediabunnyCodec: 'avc', container: 'mp4', extra: { avc: { format: 'avc' } } },
  { codec: 'vp09.00.10.08', mediabunnyCodec: 'vp9', container: 'webm', extra: {} },
  { codec: 'vp8', mediabunnyCodec: 'vp8', container: 'webm', extra: {} },
];

/** Frames older than this are dropped from the in-memory buffer (always from a keyframe boundary). */
const RETENTION_MS = 30_000;
/** A keyframe at least this often, so a clip can start close to the requested moment - a clip
 *  can only begin on a keyframe without re-encoding. */
const KEYFRAME_INTERVAL_MS = 400;
/** Frames beyond this many waiting for the encoder are dropped instead of piling up. */
const MAX_ENCODE_QUEUE = 12;
/** How many recent frames the arrival-time latency floor is estimated over (~10 s at 30 fps). */
const LATENCY_WINDOW = 300;
const END_WAIT_MAX_MS = 2_000;

export interface BufferedPacket {
  packet: EncodedPacket;
  isKey: boolean;
  /** When this frame was captured, on this device's epoch clock. */
  epochMs: number;
}

/**
 * Picks which buffered packets make up a clip for [windowStart, windowEnd]: from the last keyframe
 * at or before the window start (a clip can't start mid-GOP without re-encoding) through the last
 * frame captured at or before the window end. Returns null if nothing usable is buffered.
 */
export function selectClipRange(
  packets: readonly BufferedPacket[],
  windowStartEpoch: number,
  windowEndEpoch: number,
): { startIndex: number; endIndex: number } | null {
  if (packets.length === 0) return null;
  let startIndex = -1;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    if (p.epochMs > windowStartEpoch) break;
    if (p.isKey) startIndex = i;
  }
  if (startIndex < 0) startIndex = packets.findIndex((p) => p.isKey);
  if (startIndex < 0) return null;

  let endIndex = -1;
  for (let i = packets.length - 1; i >= startIndex; i--) {
    if (packets[i].epochMs <= windowEndEpoch) {
      endIndex = i;
      break;
    }
  }
  return endIndex < startIndex ? null : { startIndex, endIndex };
}

/**
 * Records the camera as encoded frames, each stamped with the epoch time it was captured at
 * (rather than "somewhere after MediaRecorder started"), and cuts clips on exact frame boundaries
 * without re-encoding. Encoded frames live in a bounded in-memory buffer, so unlike one growing
 * recording this never gets slower or bigger the longer a session runs, and extracting a clip is
 * just a remux.
 */
export class FrameRecorder {
  static isSupported(): boolean {
    return (
      typeof VideoEncoder !== 'undefined' &&
      typeof VideoFrame !== 'undefined' &&
      typeof MediaStreamTrackProcessor !== 'undefined'
    );
  }

  timingSource: TimingSource | null = null;
  /** MIME type of the clips this recorder produces, once the encoder is configured. */
  mimeType = '';

  private running = false;
  private track: MediaStreamTrack | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private encoder: VideoEncoder | null = null;
  private codec: CodecChoice | null = null;
  private decoderConfig: VideoDecoderConfig | null = null;
  private packets: BufferedPacket[] = [];
  private baseEpochMs: number | null = null;
  private lastTimestampUs = -1;
  private lastKeyEpochMs = -Infinity;
  private frameRate = 30;
  private frameDurationUs = 33_333;
  private latencySamples: number[] = [];
  private outputsSinceTrim = 0;
  private framesIn = 0;
  private framesDropped = 0;
  private frameSize = '';
  private recentIntervalsMs: number[] = [];
  private lastCaptureEpochMs: number | null = null;
  private resolveReady!: (ok: boolean) => void;
  private readySettled = false;

  /** Resolves true once the first frame was encoded successfully, false if this browser/device
   *  can't do it (so the caller can fall back to a plain MediaRecorder). */
  readonly ready: Promise<boolean> = new Promise((resolve) => (this.resolveReady = resolve));

  start(stream: MediaStream, getTimingOffsetMs: () => number): void {
    const source = stream.getVideoTracks()[0];
    if (!source || typeof MediaStreamTrackProcessor === 'undefined') {
      this.settleReady(false);
      return;
    }
    this.running = true;
    // A clone, so stopping this recorder can never stop the camera track the preview/others use.
    this.track = source.clone();
    this.frameRate = this.track.getSettings().frameRate || 30;
    this.frameDurationUs = Math.round(1e6 / this.frameRate);
    this.reader = new MediaStreamTrackProcessor({ track: this.track }).readable.getReader();
    void this.pump(getTimingOffsetMs);
  }

  stop(): void {
    this.running = false;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.track?.stop();
    this.track = null;
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      // already closed
    }
    this.encoder = null;
    this.packets = [];
    this.settleReady(false);
  }

  /**
   * Waits until the window has been recorded, then returns a clip from the last keyframe at or
   * before `windowStartEpoch` through the last frame at or before `windowEndEpoch` (epoch ms on
   * this device's clock). `onClipping` fires once the footage is in hand, before the remux.
   */
  async extract(windowStartEpoch: number, windowEndEpoch: number, onClipping?: () => void): Promise<FrameClip> {
    const waitMs = windowEndEpoch - epochNow();
    if (waitMs > 0) await sleep(waitMs);
    // Encoders trail the camera by a few frames - give the frames right up to the window end time to come out.
    const waitStart = epochNow();
    const giveUpAt = waitStart + END_WAIT_MAX_MS;
    while (this.running && this.latestEpoch() < windowEndEpoch && epochNow() < giveUpAt) {
      await sleep(15);
    }
    const waitedForEndMs = epochNow() - waitStart;

    const range = selectClipRange(this.packets, windowStartEpoch, windowEndEpoch);
    const codec = this.codec;
    if (!range || !codec || !this.decoderConfig) throw new Error('No buffered footage covers this clip');
    const selected = this.packets.slice(range.startIndex, range.endIndex + 1);
    onClipping?.();

    const remuxStart = performance.now();
    const target = new BufferTarget();
    const format = codec.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat();
    const output = new Output({ format, target });
    const source = new EncodedVideoPacketSource(codec.mediabunnyCodec);
    output.addVideoTrack(source, { frameRate: this.frameRate });
    await output.start();
    const firstTimestamp = selected[0].packet.timestamp;
    for (let i = 0; i < selected.length; i++) {
      const shifted = selected[i].packet.clone({ timestamp: selected[i].packet.timestamp - firstTimestamp });
      await source.add(shifted, i === 0 ? { decoderConfig: this.decoderConfig } : undefined);
    }
    await output.finalize();
    if (!target.buffer) throw new Error('Clip remux produced no output');
    return {
      blob: new Blob([target.buffer], { type: this.mimeType }),
      startEpochMs: selected[0].epochMs,
      debug: {
        timing: this.timingSource ?? 'unknown',
        frames: selected.length,
        startLeadMs: windowStartEpoch - selected[0].epochMs,
        endShortMs: windowEndEpoch - selected[selected.length - 1].epochMs,
        waitedForEndMs,
        remuxMs: performance.now() - remuxStart,
        codec: codec.codec,
        size: this.frameSize,
        fps: this.frameRate,
      },
    };
  }

  getStats(): RecorderStats {
    const intervals = this.recentIntervalsMs;
    const mean = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    const maxDev = intervals.length ? Math.max(...intervals.map((i) => Math.abs(i - mean))) : 0;
    const first = this.packets[0];
    const last = this.packets[this.packets.length - 1];
    return {
      timing: this.timingSource,
      codec: this.codec?.codec ?? '',
      size: this.frameSize,
      fps: this.frameRate,
      framesIn: this.framesIn,
      framesDropped: this.framesDropped,
      bufferedFrames: this.packets.length,
      bufferedSeconds: first && last ? (last.epochMs - first.epochMs) / 1000 : 0,
      intervalMeanMs: mean,
      intervalMaxDevMs: maxDev,
      arrivalJitterMs:
        this.timingSource === 'smoothed-arrival' && this.latencySamples.length
          ? Math.max(...this.latencySamples) - Math.min(...this.latencySamples)
          : null,
    };
  }

  private latestEpoch(): number {
    const last = this.packets[this.packets.length - 1];
    return last ? last.epochMs : -Infinity;
  }

  private async pump(getTimingOffsetMs: () => number): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    try {
      while (this.running) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        try {
          await this.handleFrame(frame, getTimingOffsetMs());
        } finally {
          frame.close();
        }
      }
    } catch (err) {
      if (this.running) console.error('Frame recorder stopped', err);
      this.settleReady(false);
    }
  }

  private async handleFrame(frame: VideoFrame, timingOffsetMs: number): Promise<void> {
    const arrival = epochNow();
    this.framesIn++;
    if (!this.encoder && !(await this.initEncoder(frame))) {
      this.running = false;
      this.settleReady(false);
      return;
    }
    const encoder = this.encoder;
    if (!encoder || encoder.state !== 'configured' || encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      this.framesDropped++;
      return;
    }

    // A positive offset says "this camera's video runs behind the others" - its frames really
    // happened earlier than they're stamped, so they're moved earlier on the shared timeline.
    const epoch = this.captureEpoch(frame, arrival) - timingOffsetMs;
    if (this.baseEpochMs === null) this.baseEpochMs = epoch;
    const timestampUs = Math.round((epoch - this.baseEpochMs) * 1000);
    if (timestampUs <= this.lastTimestampUs) {
      this.framesDropped++;
      return;
    }
    this.lastTimestampUs = timestampUs;
    if (this.lastCaptureEpochMs !== null) {
      this.recentIntervalsMs.push(epoch - this.lastCaptureEpochMs);
      if (this.recentIntervalsMs.length > 90) this.recentIntervalsMs.shift();
    }
    this.lastCaptureEpochMs = epoch;

    const needKey = epoch - this.lastKeyEpochMs >= KEYFRAME_INTERVAL_MS;
    if (needKey) this.lastKeyEpochMs = epoch;
    const stamped = new VideoFrame(frame, { timestamp: timestampUs, duration: this.frameDurationUs });
    try {
      encoder.encode(stamped, { keyFrame: needKey });
    } finally {
      stamped.close();
    }
  }

  private captureEpoch(frame: VideoFrame, arrivalEpoch: number): number {
    let captureTime: unknown;
    try {
      captureTime = (frame as unknown as { metadata?: () => { captureTime?: number } }).metadata?.().captureTime;
    } catch {
      captureTime = undefined;
    }
    if (typeof captureTime === 'number') {
      this.timingSource = 'capture-time';
      return performance.timeOrigin + captureTime;
    }

    // No capture time from the browser: frame.timestamp ticks on the camera's own steady clock, so
    // its spacing is exact while arrival times jitter with main-thread scheduling. Anchoring that
    // steady clock to the *lowest* recent arrival delay removes the jitter, leaving only a
    // constant latency offset (which the timing-offset setting can compensate).
    this.timingSource = 'smoothed-arrival';
    const timestampMs = frame.timestamp / 1000;
    this.latencySamples.push(arrivalEpoch - timestampMs);
    if (this.latencySamples.length > LATENCY_WINDOW) this.latencySamples.shift();
    return timestampMs + Math.min(...this.latencySamples);
  }

  private async initEncoder(firstFrame: VideoFrame): Promise<boolean> {
    const width = firstFrame.displayWidth;
    const height = firstFrame.displayHeight;
    this.frameSize = `${width}x${height}`;
    // Scaled by picture size, and by ~1.5x at 60 fps (twice the frames, but consecutive frames are
    // more alike, so it doesn't need twice the bits).
    const rateFactor = this.frameRate > 45 ? 1.5 : 1;
    const bitrate = Math.round(Math.min(14e6, Math.max(2e6, 6e6 * rateFactor * ((width * height) / (1920 * 1080)))));
    for (const choice of CODEC_CHOICES) {
      const config: VideoEncoderConfig = {
        codec: choice.codec,
        width,
        height,
        bitrate,
        framerate: this.frameRate,
        latencyMode: 'realtime',
        ...choice.extra,
      };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (!support.supported) continue;
        const encoder = new VideoEncoder({
          output: (chunk, meta) => this.onEncoded(chunk, meta),
          error: (err) => {
            console.error('Video encoder failed', err);
            this.running = false;
            this.settleReady(false);
          },
        });
        encoder.configure(config);
        this.encoder = encoder;
        this.codec = choice;
        this.mimeType = choice.container === 'mp4' ? 'video/mp4' : 'video/webm';
        return true;
      } catch {
        // try the next codec
      }
    }
    return false;
  }

  private onEncoded(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (meta?.decoderConfig && !this.decoderConfig) this.decoderConfig = meta.decoderConfig;
    if (this.baseEpochMs === null) return;
    const packet = EncodedPacket.fromEncodedChunk(chunk);
    this.packets.push({
      packet,
      isKey: chunk.type === 'key',
      epochMs: this.baseEpochMs + chunk.timestamp / 1000,
    });
    this.settleReady(true);
    if (++this.outputsSinceTrim >= 30) {
      this.outputsSinceTrim = 0;
      this.trim();
    }
  }

  /** Drops old footage, always keeping the buffer starting on a keyframe so it stays decodable. */
  private trim(): void {
    const cutoff = epochNow() - RETENTION_MS;
    let keepFrom = 0;
    for (let i = 0; i < this.packets.length; i++) {
      const p = this.packets[i];
      if (p.epochMs > cutoff) break;
      if (p.isKey) keepFrom = i;
    }
    if (keepFrom > 0) this.packets.splice(0, keepFrom);
  }

  private settleReady(ok: boolean): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady(ok);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
