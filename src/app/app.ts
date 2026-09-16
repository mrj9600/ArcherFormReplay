import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly navLinks = [
    { path: '/home', label: 'Home', icon: 'home' },
    { path: '/record', label: 'Record', icon: 'videocam' },
    { path: '/review', label: 'Review', icon: 'play_circle' },
    { path: '/session', label: 'Session', icon: 'devices' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];
}
