import { Component, DestroyRef, ElementRef, OnInit, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatChipsModule } from '@angular/material/chips';
import { CameraService } from '../../services/camera.service';
import { RollingBufferRecorderService } from '../../services/rolling-buffer-recorder.service';
import { METER_DISPLAY_SCALE, SoundTriggerService } from '../../services/sound-trigger.service';
import { SettingsService } from '../../services/settings.service';
import { ClipStoreService } from '../../services/clip-store.service';
import { SessionService } from '../../services/session.service';

type RecordStatus = 'starting' | 'listening' | 'waiting-for-master' | 'capturing' | 'error';

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
  protected readonly session = inject(SessionService);
  private readonly clipStore = inject(ClipStoreService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('preview');
  protected readonly status = signal<RecordStatus>('starting');
  protected readonly meterScale = METER_DISPLAY_SCALE;

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
      const isSlave = this.session.role() === 'slave';
      const stream = await this.camera.start(undefined, !isSlave);
      this.buffer.start(stream, this.settings.settings().chunkMs);

      if (isSlave) {
        this.status.set('waiting-for-master');
        this.session.localTrigger$
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(({ localTs, masterTs }) => this.handleSlaveTrigger(localTs, masterTs));
      } else {
        this.soundTrigger.start(stream, this.settings.settings().micSensitivity);
        this.status.set('listening');
        this.soundTrigger.trigger$
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(({ timestamp }) => this.handleLocalTrigger(timestamp));
      }
    } catch {
      this.status.set('error');
    }
  }

  protected testTrigger(): void {
    this.soundTrigger.manualTrigger();
  }

  private async handleLocalTrigger(timestamp: number): Promise<void> {
    if (this.status() === 'capturing') return;
    this.status.set('capturing');

    const isMaster = this.session.role() === 'master';
    const expectedSlaveCount = this.session.expectedClipCount;
    if (isMaster) this.session.broadcastTrigger(timestamp);

    const { preRollSeconds, postRollSeconds } = this.settings.settings();
    const [ownBlob, slaveClips] = await Promise.all([
      this.buffer.extractClip(timestamp, preRollSeconds, postRollSeconds),
      isMaster ? this.session.collectClips(timestamp) : Promise.resolve(new Map<string, Blob>()),
    ]);

    const items = [{ deviceLabel: isMaster ? 'You (master)' : 'You', blob: ownBlob }];
    let index = 1;
    for (const [slaveId, blob] of slaveClips) {
      index += 1;
      items.push({ deviceLabel: `Camera ${index} (${slaveId.slice(-4)})`, blob });
    }
    const missing = expectedSlaveCount - slaveClips.size;
    this.clipStore.setClips(items, missing > 0 ? `${missing} device(s) didn't respond in time and are missing.` : undefined);

    this.status.set('listening');
    void this.router.navigate(['/review']);
  }

  private async handleSlaveTrigger(localTs: number, masterTs: number): Promise<void> {
    if (this.status() === 'capturing') return;
    this.status.set('capturing');
    const { preRollSeconds, postRollSeconds } = this.settings.settings();
    const blob = await this.buffer.extractClip(localTs, preRollSeconds, postRollSeconds);
    this.session.sendClip(blob, this.buffer.mimeTypeUsed(), masterTs);
    this.status.set('waiting-for-master');
  }
}
