import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { SwUpdate } from '@angular/service-worker';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule, MatButtonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly swUpdate = inject(SwUpdate);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly updateAvailable = signal(false);

  protected readonly navLinks = [
    { path: '/home', label: 'Home', icon: 'home' },
    { path: '/record', label: 'Record', icon: 'videocam' },
    { path: '/review', label: 'Review', icon: 'play_circle' },
    { path: '/session', label: 'Session', icon: 'devices' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];

  constructor() {
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
        if (event.type === 'VERSION_READY') {
          this.updateAvailable.set(true);
        }
      });

      // The initial check happens on registration, but a session can stay open a long time (a
      // whole practice session) - keep checking periodically so an update doesn't require
      // fully closing and reopening the app to be noticed.
      const checkInterval = setInterval(() => void this.swUpdate.checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
      this.destroyRef.onDestroy(() => clearInterval(checkInterval));
    }
  }

  protected reloadForUpdate(): void {
    // Without this, the reload races against the new service worker's activation: it can stay
    // "waiting" (the old one still controlling this page) through the reload, so the page comes
    // back with a mismatched mix of old and new cached assets - e.g. new index.html/CSS paired
    // with the old compiled JS bundle - instead of a clean, fully-new version.
    void this.swUpdate.activateUpdate().finally(() => document.location.reload());
  }
}
