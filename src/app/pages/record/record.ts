import { Component, DestroyRef, ElementRef, OnInit, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatChipsModule } from '@angular/material/chips';
import { CameraService } from '../../services/camera.service';
import { RollingBufferRecorderService } from '../../services/rolling-buffer-recorder.service';
import { SoundTriggerService } from '../../services/sound-trigger.service';
import { SettingsService } from '../../services/settings.service';
import { ClipStoreService } from '../../services/clip-store.service';

type RecordStatus = 'starting' | 'listening' | 'capturing' | 'error';

@Component({
  selector: 'app-record',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule, MatChipsModule],
  templateUrl: './record.html',
  styleUrl: './record.scss',
})
export class Record implements OnInit {
  protected readonly camera = inject(CameraService);
  protected readonly buffer = inject(RollingBufferRecorderService);
  protected readonly soundTrigger = inject(SoundTriggerService);
  protected readonly settings = inject(SettingsService);
  private readonly clipStore = inject(ClipStoreService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('preview');
  protected readonly status = signal<RecordStatus>('starting');

  constructor() {
    effect(() => {
      const video = this.videoRef()?.nativeElement;
      const stream = this.camera.stream();
      if (video && stream) {
        video.srcObject = stream;
      }
    });

    this.destroyRef.onDestroy(() => {
      this.soundTrigger.stop();
      this.buffer.stop();
      this.camera.stop();
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      const stream = await this.camera.start();
      this.buffer.start(stream, this.settings.settings().chunkMs);
      this.soundTrigger.start(stream, this.settings.settings().micSensitivity);
      this.status.set('listening');

      this.soundTrigger.trigger$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ timestamp }) => {
        this.handleTrigger(timestamp);
      });
    } catch {
      this.status.set('error');
    }
  }

  protected testTrigger(): void {
    this.soundTrigger.manualTrigger();
  }

  private async handleTrigger(timestamp: number): Promise<void> {
    if (this.status() === 'capturing') return;
    this.status.set('capturing');
    const { preRollSeconds, postRollSeconds } = this.settings.settings();
    const blob = await this.buffer.extractClip(timestamp, preRollSeconds, postRollSeconds);
    this.clipStore.setClip(blob);
    this.status.set('listening');
    void this.router.navigate(['/review']);
  }
}
