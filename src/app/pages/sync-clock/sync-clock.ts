import { Component, DestroyRef, ElementRef, inject, viewChild } from '@angular/core';
import { epochNow } from '../../services/time';

/**
 * A big millisecond clock to film, for measuring real-world multi-camera sync: point every camera
 * at this screen, take a shot, then pause Review at one timeline position - each camera's frame
 * should show (almost) the same reading, and any consistent difference is that camera's timing
 * error (which the timing offset setting can then cancel). The reading comes from whichever
 * device shows this page; cameras compare readings with each other, not against a clock.
 */
@Component({
  selector: 'app-sync-clock',
  templateUrl: './sync-clock.html',
  styleUrl: './sync-clock.scss',
})
export class SyncClock {
  private readonly readout = viewChild.required<ElementRef<HTMLElement>>('readout');

  constructor() {
    let handle = 0;
    const draw = () => {
      const now = epochNow();
      const totalMs = Math.floor(now % 100_000);
      const seconds = Math.floor(totalMs / 1000);
      const ms = totalMs % 1000;
      this.readout().nativeElement.textContent = `${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
      handle = requestAnimationFrame(draw);
    };
    handle = requestAnimationFrame(draw);
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(handle));
  }
}
