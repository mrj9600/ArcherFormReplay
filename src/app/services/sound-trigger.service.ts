import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export interface TriggerEvent {
  timestamp: number;
}

/** Listens to a mic stream and fires a trigger when a loud, sudden sound (the arrow release) is detected. */
@Injectable({ providedIn: 'root' })
export class SoundTriggerService {
  readonly trigger$ = new Subject<TriggerEvent>();
  readonly isListening = signal(false);
  /** Current RMS level (0-1ish), for a live meter in the UI. */
  readonly level = signal(0);

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rafHandle: number | null = null;
  private lastTriggerAt = 0;
  private threshold = 0.15;
  private readonly refractoryMs = 1500;

  start(stream: MediaStream, threshold: number): void {
    this.stop();
    this.threshold = threshold;
    this.audioContext = new AudioContext();
    this.source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);
    this.isListening.set(true);
    this.loop();
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.analyser = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.isListening.set(false);
    this.level.set(0);
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold;
  }

  manualTrigger(): void {
    this.emitTrigger(performance.now());
  }

  private loop = (): void => {
    if (!this.analyser) return;
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);

    let sumSquares = 0;
    for (const sample of data) sumSquares += sample * sample;
    const rms = Math.sqrt(sumSquares / data.length);
    this.level.set(rms);

    const now = performance.now();
    if (rms >= this.threshold && now - this.lastTriggerAt > this.refractoryMs) {
      this.emitTrigger(now);
    }

    this.rafHandle = requestAnimationFrame(this.loop);
  };

  private emitTrigger(timestamp: number): void {
    this.lastTriggerAt = timestamp;
    this.trigger$.next({ timestamp });
  }
}
