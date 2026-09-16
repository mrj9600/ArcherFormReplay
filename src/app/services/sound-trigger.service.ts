import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export interface TriggerEvent {
  timestamp: number;
}

/** Multiplier used to stretch the 0-1 peak amplitude into a more readable 0-100% meter. */
export const METER_DISPLAY_SCALE = 250;

/** Listens to a mic stream and fires a trigger when a loud, sudden sound (the arrow release) is detected. */
@Injectable({ providedIn: 'root' })
export class SoundTriggerService {
  readonly trigger$ = new Subject<TriggerEvent>();
  readonly isListening = signal(false);
  /** Current peak amplitude (0-1), for a live meter in the UI. Peak (not RMS) responds better to a short, sharp release sound. */
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
    this.analyser.fftSize = 1024;
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

    let peak = 0;
    for (const sample of data) {
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    this.level.set(peak);

    const now = performance.now();
    if (peak >= this.threshold && now - this.lastTriggerAt > this.refractoryMs) {
      this.emitTrigger(now);
    }

    this.rafHandle = requestAnimationFrame(this.loop);
  };

  private emitTrigger(timestamp: number): void {
    this.lastTriggerAt = timestamp;
    this.trigger$.next({ timestamp });
  }
}
