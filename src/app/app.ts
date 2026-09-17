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
    document.location.reload();
  }
}
