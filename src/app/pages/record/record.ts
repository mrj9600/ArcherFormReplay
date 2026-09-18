import { Component, DestroyRef, ElementRef, OnInit, computed, effect, inject, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
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

type RecordStatus = 'listening' | 'waiting-for-master' | 'coordinating' | 'manual-only' | 'capturing' | 'error';

@Component({
  selector: 'app-record',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule, MatChipsModule, NgTemplateOutlet],
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

  /** True once mic-based release detection has been tried and failed for this trigger device -
   *  distinct from the fatal 'error' status: a device with no camera/mic can still coordinate
   *  and be triggered manually, so this degrades the status text instead of blocking the page.
   *  Declared before `status` below since its initializer calls computeIdleStatus(), which reads
   *  this - class fields initialize in declaration order. */
  protected readonly micUnavailable = signal(false);

  protected readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('preview');
  protected readonly status = signal<RecordStatus>(this.computeIdleStatus());
  protected readonly meterScale = METER_DISPLAY_SCALE;
  protected readonly recordsVideo = signal(true);

  /** Master always gets a manual override; a slave only gets one when it's the assigned trigger device. */
  protected readonly showTestButton = computed(() => this.session.role() !== 'slave' || this.session.isTriggerDevice());

  /** Master only, while recording its own video: true once its own clip has been extracted for
   *  the in-progress trigger - session.collectionProgress() only tracks slave arrivals, so this
   *  is folded in separately to make "Collecting clips…" reflect the master's own clip too. */
  private readonly ownClipReady = signal(false);
  protected readonly collectionDisplay = computed(() => {
    const progress = this.session.collectionProgress();
    if (!progress) return null;
    const includesOwn = this.recordsVideo();
    return {
      received: progress.received + (includesOwn && this.ownClipReady() ? 1 : 0),
      expected: progress.expected + (includesOwn ? 1 : 0),
    };
  });

  private readonly isReady = signal(false);
  private micOnlyStream: MediaStream | null = null;
  private acquiringMic = false;

  /** Auto-save naming (see settings.autoSaveClips): fixed to the first shot after this page
   *  opens, then reused for every later shot in the same visit - only the shot number advances. */
  private sessionTimestamp: string | null = null;
  private sessionShotNumber = 0;

  constructor() {
    effect(() => {
      const video = this.videoRef()?.nativeElement;
      const stream = this.camera.stream();
      if (video && stream) {
        video.srcObject = stream;
      }
    });

    // Keeps sound detection in sync with which device is currently assigned as the trigger
    // device - this can change (from the Session page) *after* this page has already mounted,
    // e.g. right after a slave joins with no mic yet and is then promoted to trigger device.
    effect(() => {
      if (!this.isReady()) return;
      const isTrigger = this.session.isTriggerDevice();

      if (!isTrigger) {
        this.soundTrigger.stop();
        if (this.micOnlyStream) {
          this.micOnlyStream.getTracks().forEach((track) => track.stop());
          this.micOnlyStream = null;
        }
        this.micUnavailable.set(false);
        this.syncIdleStatus();
        return;
      }

      const cameraStream = this.camera.stream();
      if (this.recordsVideo() && cameraStream && cameraStream.getAudioTracks().length > 0) {
        this.soundTrigger.start(cameraStream, this.settings.settings().micSensitivity);
        this.micUnavailable.set(false);
        this.syncIdleStatus();
      } else if (!this.micOnlyStream && !this.acquiringMic) {
        this.acquiringMic = true;
        navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((stream) => {
            this.micOnlyStream = stream;
            this.soundTrigger.start(stream, this.settings.settings().micSensitivity);
            this.micUnavailable.set(false);
            this.syncIdleStatus();
          })
          .catch(() => {
            // No mic available either - not fatal, this device just can't self-detect a release.
            // It can still coordinate/be triggered manually (see showTestButton/testTrigger).
            this.micUnavailable.set(true);
            this.syncIdleStatus();
          })
          .finally(() => {
            this.acquiringMic = false;
          });
      }
    });

    this.destroyRef.onDestroy(() => {
      this.soundTrigger.stop();
      this.buffer.stop();
      this.camera.stop();
      this.micOnlyStream?.getTracks().forEach((track) => track.stop());
    });
  }

  async ngOnInit(): Promise<void> {
    this.sessionTimestamp = null;
    this.sessionShotNumber = 0;

    try {
      const role = this.session.role();
      const isSlave = role === 'slave';
      const recordsVideo = isSlave ? true : this.session.masterRecordsVideo();
      this.recordsVideo.set(recordsVideo);

      if (recordsVideo) {
        // Audio is only baked into the recording if this device was already the trigger device
        // when recording started; that can't change later without restarting the buffer (and
        // losing its history), so a later trigger-device reassignment only affects live
        // detection (handled reactively above), not whether the recorded clip itself has sound.
        const withAudio = this.session.isTriggerDevice();
        try {
          const stream = await this.camera.start(undefined, withAudio);
          this.buffer.start(stream);
        } catch (err) {
          // A slave's whole purpose is contributing a camera angle - no camera is fatal there.
          // The master (or a solo device) can still coordinate/be triggered manually without
          // recording its own video, so fall back to that instead of hard-failing the page.
          if (isSlave) throw err;
          this.recordsVideo.set(false);
        }
      }

      if (isSlave) {
        this.session.localTrigger$
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(({ localTs, triggerSeq }) => this.handleSlaveTrigger(localTs, triggerSeq));
        this.soundTrigger.trigger$
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(({ timestamp }) => this.session.reportLocalTrigger(timestamp));
      } else {
        this.soundTrigger.trigger$
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(({ timestamp }) => this.handleLocalTrigger(timestamp));
        if (role === 'master') {
          this.session.remoteTriggerRequested$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((estimatedMasterTs) => this.handleLocalTrigger(estimatedMasterTs));
        }
      }

      this.isReady.set(true);
      this.syncIdleStatus();
    } catch {
      this.status.set('error');
    }
  }

  protected testTrigger(): void {
    if (this.session.role() === 'slave') {
      if (this.session.isTriggerDevice()) this.session.reportLocalTrigger(performance.now());
      return;
    }
    this.soundTrigger.manualTrigger();
  }

  private syncIdleStatus(): void {
    if (this.status() === 'capturing' || this.status() === 'error') return;
    this.status.set(this.computeIdleStatus());
  }

  /** Unconditionally returns to the idle status - unlike syncIdleStatus(), which deliberately
   *  leaves 'capturing' alone so reactive settings/role changes can't clobber an active capture.
   *  A trigger handler's own finally block is the one legitimate place that capturing state
   *  needs to be cleared from, so it must bypass that guard rather than go through it. */
  private clearCapturingStatus(): void {
    this.status.set(this.computeIdleStatus());
  }

  /** The role/trigger-device-aware status to show whenever nothing is actively capturing -
   *  used both as the initial value (so the page never shows a generic "starting" state) and
   *  whenever role/trigger-device assignment changes. */
  private computeIdleStatus(): RecordStatus {
    const isSlave = this.session.role() === 'slave';
    const isTrigger = this.session.isTriggerDevice();
    if (isTrigger && this.micUnavailable()) return 'manual-only';
    if (isSlave) return isTrigger ? 'listening' : 'waiting-for-master';
    return isTrigger ? 'listening' : 'coordinating';
  }

  private async handleLocalTrigger(timestamp: number): Promise<void> {
    if (this.status() === 'capturing') return;
    this.status.set('capturing');

    try {
      const isMaster = this.session.role() === 'master';
      const recordsVideo = this.recordsVideo();
      const expectedSlaveCount = this.session.expectedClipCount;
      const triggerSeq = isMaster ? this.session.broadcastTrigger(timestamp) : -1;
      this.ownClipReady.set(false);

      const { preRollSeconds, postRollSeconds } = this.settings.settings();
      const ownClipPromise = recordsVideo
        ? this.buffer.extractClip(timestamp, preRollSeconds, postRollSeconds).then((blob) => {
            this.ownClipReady.set(true);
            return blob;
          })
        : Promise.resolve(null);
      const [ownBlob, slaveClips] = await Promise.all([
        ownClipPromise,
        isMaster ? this.session.collectClips(triggerSeq) : Promise.resolve(new Map<string, Blob>()),
      ]);

      const items: { deviceLabel: string; blob: Blob }[] = [];
      if (ownBlob) items.push({ deviceLabel: isMaster ? 'You (master)' : 'You', blob: ownBlob });
      let index = 1;
      for (const [slaveId, blob] of slaveClips) {
        index += 1;
        items.push({ deviceLabel: `Camera ${index} (${slaveId.slice(-4)})`, blob });
      }
      const missing = expectedSlaveCount - slaveClips.size;
      if (missing > 0) {
        console.warn(`${missing} device(s) didn't respond in time and are missing from this shot.`);
      }

      if (this.settings.settings().autoSaveClips) {
        this.saveClipsAutomatically(items);
      } else {
        this.clipStore.setClips(items, missing > 0 ? `${missing} device(s) didn't respond in time and are missing.` : undefined);
        void this.router.navigate(['/review']);
      }
    } catch (err) {
      console.error('Local trigger handling failed', err);
    } finally {
      // Always clears the 'capturing' state, even on an unexpected error - otherwise the device
      // would be stuck refusing every future trigger.
      this.clearCapturingStatus();
    }
  }

  /** Downloads every clip from this shot straight to the device, named
   *  {yyyyMMddHHmm}_{shot}_{camera}.{ext} - the timestamp is locked to the first shot of this
   *  visit to Record (see ngOnInit) and reused for every later shot; only the shot number and
   *  camera number change. Staggered slightly, like Review's "Download all" - firing several
   *  download-triggering clicks in the same tick makes some browsers silently drop all but the
   *  first. */
  private saveClipsAutomatically(items: { deviceLabel: string; blob: Blob }[]): void {
    if (items.length === 0) return;
    if (!this.sessionTimestamp) {
      this.sessionTimestamp = this.formatSessionTimestamp(new Date());
    }
    this.sessionShotNumber += 1;
    const shotNo = String(this.sessionShotNumber).padStart(2, '0');

    items.forEach((item, i) => {
      const cameraNo = i + 1;
      const ext = item.blob.type.includes('mp4') ? 'mp4' : 'webm';
      const filename = `${this.sessionTimestamp}_${shotNo}_${cameraNo}.${ext}`;
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(item.blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 200);
    });
  }

  private formatSessionTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  private async handleSlaveTrigger(localTs: number, triggerSeq: number): Promise<void> {
    if (this.status() === 'capturing') return;
    this.status.set('capturing');
    try {
      const { preRollSeconds, postRollSeconds } = this.settings.settings();
      const blob = await this.buffer.extractClip(localTs, preRollSeconds, postRollSeconds);
      this.session.sendClip(blob, this.buffer.mimeTypeUsed(), triggerSeq);
    } catch (err) {
      console.error('Slave trigger handling failed', err);
    } finally {
      this.clearCapturingStatus();
    }
  }
}
