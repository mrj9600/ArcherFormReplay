import { Component, DestroyRef, ElementRef, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { CameraService } from '../../services/camera.service';
import { RollingBufferRecorderService } from '../../services/rolling-buffer-recorder.service';
import { SoundTriggerService } from '../../services/sound-trigger.service';
import { SettingsService } from '../../services/settings.service';
import { ClipStoreService } from '../../services/clip-store.service';
import { CollectionResult, LocalTriggerEvent, SessionService } from '../../services/session.service';
import { ClipDebug, DEVICE_STATE_LABELS, DeviceState } from '../../services/session-protocol';
import { epochNow } from '../../services/time';
import { MicCalibration } from '../../components/mic-calibration/mic-calibration';

/**
 * What this device is doing, in the order a shot goes through them:
 * idle (slave, not armed) -> listening / waiting-for-master (armed) -> capturing (the post-roll
 * after the trigger is still being recorded) -> clipping (cutting the clip) -> sending (slave:
 * uploading it) or collecting (master: waiting for the slaves' clips).
 */
type RecordStatus =
  | 'idle'
  | 'listening'
  | 'waiting-for-master'
  | 'coordinating'
  | 'manual-only'
  | 'capturing'
  | 'clipping'
  | 'sending'
  | 'collecting'
  | 'error';

const BUSY_STATUSES: readonly RecordStatus[] = ['capturing', 'clipping', 'sending', 'collecting'];
/** A slave stays "sending" until the master acknowledges the clip; if that ack never comes
 *  (e.g. the master moved on), give up waiting after this long instead of hanging forever. */
const CLIP_ACK_TIMEOUT_MS = 90_000;

@Component({
  selector: 'app-record',
  imports: [MatButtonModule, MatIconModule, MatChipsModule, NgTemplateOutlet, MicCalibration],
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
  protected readonly recordsVideo = signal(true);
  /** True while a shot is in progress on this device (anything from the trigger until its clip
   *  has been delivered) - further triggers are ignored and idle-status syncing is suspended. */
  protected readonly busy = computed(() => BUSY_STATUSES.includes(this.status()));

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

  /** Master only: this device plus every connected slave with what each is currently doing, so
   *  it's clear whose clip is still to come. */
  protected readonly deviceStates = computed(() => {
    if (this.session.role() !== 'master') return [];
    const slaveStates = this.session.slaveStates();
    const slaves = this.session.connectedSlaves();
    if (slaves.length === 0) return [];
    const own = { id: 'master', label: 'You (master)', state: this.ownStateLabel() };
    return [
      own,
      ...slaves.map((slave, i) => ({
        id: slave.id,
        label: `Camera ${i + 2} (${slave.id.slice(-4)})`,
        state: DEVICE_STATE_LABELS[slaveStates[slave.id] ?? 'idle'],
      })),
    ];
  });

  /** Which timing accuracy tier this device's recording is on (see RecorderTiming). */
  protected readonly timingLabel = computed(() => {
    switch (this.buffer.timing()) {
      case 'capture-time':
        return 'Frame timing: camera capture time (precise)';
      case 'smoothed-arrival':
        return 'Frame timing: estimated from frame arrival';
      case 'basic':
        return 'Frame timing: basic (less precise sync)';
      default:
        return null;
    }
  });

  /** Timing debug numbers about the most recent clip this device cut. */
  protected readonly lastShotDebug = signal<ClipDebug | null>(null);

  /** Rows for the timing debug readout - live recorder stats, this device's clock sync, and the
   *  last clip's cut details. Left in for real-device sync testing. */
  protected readonly debugRows = computed(() => {
    const rows: { key: string; value: string }[] = [];
    const num = (n: number, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : '-');
    const stats = this.buffer.stats();
    const mode = this.buffer.mode();
    rows.push({
      key: 'Recorder',
      value:
        mode === 'precise'
          ? 'PRECISE capture (WebCodecs)'
          : mode === 'media-recorder'
            ? `MediaRecorder (basic) - ${this.buffer.fallbackReason() || 'in use'}`
            : 'not recording',
    });
    rows.push({ key: 'Frame timestamps', value: this.buffer.timing() ?? '-' });
    if (stats) {
      rows.push({ key: 'Codec', value: `${stats.codec || '-'} ${stats.size} @${num(stats.fps, 0)}fps` });
      rows.push({ key: 'Frames', value: `${stats.framesIn} in, ${stats.framesDropped} dropped, ${stats.bufferedFrames} buffered (${num(stats.bufferedSeconds)}s)` });
      rows.push({ key: 'Frame interval', value: `${num(stats.intervalMeanMs)}ms avg, max dev ${num(stats.intervalMaxDevMs)}ms` });
      if (stats.arrivalJitterMs !== null) {
        rows.push({ key: 'Arrival jitter (smoothed out)', value: `${num(stats.arrivalJitterMs)}ms` });
      }
    }
    rows.push({ key: 'Timing offset setting', value: `${this.settings.settings().videoTimingOffsetMs}ms` });
    if (this.session.role() === 'slave') {
      const sync = this.session.syncInfo();
      rows.push({
        key: 'Clock vs master',
        value: sync
          ? `${num(sync.offsetMs, 2)}ms, best RTT ${num(sync.bestRoundTripMs, 2)}ms, ${sync.freshSamples}/${sync.totalSamples} samples, age ${num(sync.bestSampleAgeMs / 1000)}s`
          : 'not synced yet',
      });
    }
    const last = this.lastShotDebug();
    if (last) {
      rows.push({ key: 'Last clip', value: Object.entries(last).map(([k, v]) => `${k}=${typeof v === 'number' ? num(v, 1) : v}`).join(' ') });
    }
    return rows;
  });

  private readonly isReady = signal(false);
  private micOnlyStream: MediaStream | null = null;
  private acquiringMic = false;

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

    // Slave: records only while the master has armed this device (i.e. is on its Record page).
    effect(() => {
      const armed = this.session.armed();
      if (!this.isReady() || this.session.role() !== 'slave') return;
      untracked(() => this.applySlaveArm(armed));
    });

    // Slave: keeps the master informed of what this device is doing.
    effect(() => {
      const status = this.status();
      if (!this.isReady() || this.session.role() !== 'slave') return;
      untracked(() => this.session.reportDeviceState(this.toDeviceState(status)));
    });

    this.destroyRef.onDestroy(() => {
      this.soundTrigger.stop();
      this.buffer.stop();
      this.camera.stop();
      this.micOnlyStream?.getTracks().forEach((track) => track.stop());
      if (this.session.role() === 'master') this.session.setArmed(false);
      if (this.session.role() === 'slave') this.session.reportDeviceState('idle');
    });
  }

  async ngOnInit(): Promise<void> {
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
          // A slave keeps its camera live but only records once the master arms it.
          if (!isSlave) this.buffer.start(stream);
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
          .subscribe((event) => this.handleSlaveTrigger(event));
        this.soundTrigger.trigger$
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(({ timestamp }) => this.reportSlaveTrigger(timestamp));
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
      if (role === 'master') this.session.setArmed(true);
    } catch {
      this.status.set('error');
    }
  }

  protected testTrigger(): void {
    if (this.session.role() === 'slave') {
      this.reportSlaveTrigger(epochNow());
      return;
    }
    this.soundTrigger.manualTrigger();
  }

  /** What the master's device list says this device is doing. */
  private ownStateLabel(): string {
    switch (this.status()) {
      case 'capturing':
        return DEVICE_STATE_LABELS.capturing;
      case 'clipping':
        return DEVICE_STATE_LABELS.clipping;
      case 'collecting':
        return 'Collecting clips';
      case 'error':
        return DEVICE_STATE_LABELS.error;
      default:
        return this.recordsVideo() ? DEVICE_STATE_LABELS.armed : 'Coordinating';
    }
  }

  private toDeviceState(status: RecordStatus): DeviceState {
    switch (status) {
      case 'capturing':
      case 'clipping':
      case 'sending':
        return status;
      case 'error':
        return 'error';
      case 'idle':
        return 'idle';
      default:
        return 'armed';
    }
  }

  private syncIdleStatus(): void {
    if (this.busy() || this.status() === 'error') return;
    this.status.set(this.computeIdleStatus());
  }

  /** Unconditionally returns to the idle status - unlike syncIdleStatus(), which deliberately
   *  leaves a shot in progress alone so reactive settings/role changes can't clobber it. A
   *  trigger handler's own finally block is the one legitimate place a busy state needs to be
   *  cleared from, so it must bypass that guard rather than go through it. */
  private clearBusyStatus(): void {
    this.status.set(this.computeIdleStatus());
  }

  /** The role/trigger-device-aware status to show whenever nothing is actively in progress -
   *  used both as the initial value (so the page never shows a generic "starting" state) and
   *  whenever role/trigger-device assignment changes. */
  private computeIdleStatus(): RecordStatus {
    const isSlave = this.session.role() === 'slave';
    const isTrigger = this.session.isTriggerDevice();
    if (isTrigger && this.micUnavailable()) return 'manual-only';
    if (isSlave) {
      if (!this.session.armed()) return 'idle';
      return isTrigger ? 'listening' : 'waiting-for-master';
    }
    return isTrigger ? 'listening' : 'coordinating';
  }

  /** Slave: starts recording when armed, stops when disarmed - and never interferes with a shot
   *  that's already in progress (its own finish re-evaluates this once it's done). */
  private applySlaveArm(armed: boolean): void {
    if (this.busy()) return;
    const stream = this.camera.stream();
    if (armed && stream && !this.buffer.isRecording()) {
      this.buffer.start(stream);
    } else if (!armed && this.buffer.isRecording()) {
      this.buffer.stop();
    }
    this.syncIdleStatus();
  }

  /** Slave that is the trigger device: only a device that's recording and free can usefully ask
   *  the master to fire - otherwise the shot would start with this camera missing. */
  private reportSlaveTrigger(timestamp: number): void {
    if (!this.session.armed() || this.busy() || !this.buffer.isRecording()) return;
    this.session.reportLocalTrigger(timestamp);
  }

  private async handleLocalTrigger(timestamp: number): Promise<void> {
    if (this.busy()) return;
    this.status.set('capturing');
    let restartAfterShot = false;

    try {
      const isMaster = this.session.role() === 'master';
      const recordsVideo = this.recordsVideo();
      const { preRollSeconds, postRollSeconds } = this.settings.settings();
      const triggerSeq = isMaster ? this.session.broadcastTrigger(timestamp, preRollSeconds, postRollSeconds) : -1;
      this.ownClipReady.set(false);

      const ownClipPromise = recordsVideo
        ? this.buffer
            .extractClip(timestamp, preRollSeconds, postRollSeconds, {
              onClipping: () => {
                this.status.set('clipping');
                // Nothing more to record for this shot - stops the encoder before the trim runs.
                this.buffer.stop();
              },
            })
            .then((clip) => {
              this.ownClipReady.set(true);
              this.lastShotDebug.set(clip.debug);
              if (isMaster && this.session.collectionProgress()) this.status.set('collecting');
              return clip;
            })
        : Promise.resolve(null);
      if (isMaster && !recordsVideo && this.session.connectedSlaves().length > 0) this.status.set('collecting');

      const [ownClip, collection] = await Promise.all([
        ownClipPromise,
        isMaster ? this.session.collectClips(triggerSeq) : Promise.resolve<CollectionResult>({ clips: new Map(), missingIds: [] }),
      ]);

      const items: { deviceLabel: string; blob: Blob; startEpochMs: number | null; debug: ClipDebug | null }[] = [];
      if (ownClip) {
        items.push({ deviceLabel: isMaster ? 'You (master)' : 'You', blob: ownClip.blob, startEpochMs: ownClip.startEpochMs, debug: ownClip.debug });
      }
      let index = 1;
      for (const [slaveId, { blob, startEpochMs, debug }] of collection.clips) {
        index += 1;
        items.push({ deviceLabel: `Camera ${index} (${slaveId.slice(-4)})`, blob, startEpochMs, debug });
      }
      const missing = collection.missingIds.length;
      if (missing > 0) {
        console.warn(`${missing} device(s) didn't deliver a clip and are missing from this shot.`);
      }

      if (this.settings.settings().autoSaveClips) this.saveClipsAutomatically(items);
      if (this.settings.settings().autoReturnLoops === 0) {
        // Auto return "Off": no Review - stay here and get ready for the next shot.
        restartAfterShot = true;
      } else {
        this.clipStore.setClips(items, missing > 0 ? `${missing} device(s) didn't deliver a clip and are missing.` : undefined);
        void this.router.navigate(['/review']);
      }
    } catch (err) {
      console.error('Local trigger handling failed', err);
    } finally {
      // Always clears the busy state, even on an unexpected error - otherwise the device
      // would be stuck refusing every future trigger.
      this.clearBusyStatus();
      if (restartAfterShot) this.rearmForNextShot();
    }
  }

  /** Staying on this page between shots means the next shot needs a fresh, short recording
   *  (rather than one that keeps growing) and slaves - idle since delivering their clips - need
   *  re-arming, exactly as if the master had just come back to Record. */
  private rearmForNextShot(): void {
    const stream = this.camera.stream();
    if (this.recordsVideo() && stream) this.buffer.start(stream);
    if (this.session.role() === 'master') this.session.setArmed(true);
  }

  /** Downloads every clip from this shot straight to the device, named
   *  {yyyyMMddHHmm}_{shot}_{camera}.{ext} - the timestamp is locked to the first shot of a
   *  shooting session (see ClipStoreService.nextAutoSaveShot); only the shot number and camera
   *  number change. Staggered slightly, like Review's "Download all" - firing several
   *  download-triggering clicks in the same tick makes some browsers silently drop all but the
   *  first. */
  private saveClipsAutomatically(items: { deviceLabel: string; blob: Blob }[]): void {
    if (items.length === 0) return;
    const { timestamp, shotNumber } = this.clipStore.nextAutoSaveShot();
    const shotNo = String(shotNumber).padStart(2, '0');

    items.forEach((item, i) => {
      const cameraNo = i + 1;
      const ext = item.blob.type.includes('mp4') ? 'mp4' : 'webm';
      const filename = `${timestamp}_${shotNo}_${cameraNo}.${ext}`;
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

  private async handleSlaveTrigger(event: LocalTriggerEvent): Promise<void> {
    const { localTs, triggerSeq, preRollSeconds, postRollSeconds } = event;
    if (this.busy() || !this.buffer.isRecording()) {
      // Not recording (never armed, or still delivering the previous shot): tell the master no
      // clip is coming from here so it doesn't sit waiting for one.
      this.session.reportDeviceState('idle', triggerSeq);
      return;
    }

    this.status.set('capturing');
    // This device has taken its shot - it stays idle until the master arms it again.
    this.session.consumeArm();
    try {
      const clip = await this.buffer.extractClip(localTs, preRollSeconds, postRollSeconds, {
        onClipping: () => {
          this.status.set('clipping');
          this.buffer.stop();
        },
      });
      this.status.set('sending');
      const acknowledged = this.waitForClipAck(triggerSeq);
      this.lastShotDebug.set(clip.debug);
      this.session.sendClip(clip.blob, clip.blob.type, triggerSeq, clip.startEpochMs, clip.debug);
      await acknowledged;
    } catch (err) {
      console.error('Slave trigger handling failed', err);
      this.session.reportDeviceState('error', triggerSeq);
    } finally {
      this.clearBusyStatus();
      // Idle unless the master already re-armed this device while it was still delivering.
      this.applySlaveArm(this.session.armed());
    }
  }

  private waitForClipAck(triggerSeq: number): Promise<void> {
    return new Promise((resolve) => {
      const subscription = this.session.clipAcknowledged$.subscribe((seq) => {
        if (seq === triggerSeq) done();
      });
      const timer = setTimeout(done, CLIP_ACK_TIMEOUT_MS);
      function done(): void {
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve();
      }
    });
  }
}
