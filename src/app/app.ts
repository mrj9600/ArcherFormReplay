import { Component, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatToolbarModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly title = signal('ArcherFormReplay');

  protected readonly navLinks = [
    { path: '/home', label: 'Home', icon: 'home' },
    { path: '/record', label: 'Record', icon: 'videocam' },
    { path: '/session', label: 'Session', icon: 'devices' },
    { path: '/review', label: 'Review', icon: 'play_circle' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];
}
