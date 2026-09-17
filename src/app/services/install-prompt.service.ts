import { Injectable, signal } from '@angular/core';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}


/** Captures the browser's install prompt (Chrome/Edge/Android) so it can be triggered from our own UI instead of waiting on the browser's own heuristics. */
@Injectable({ providedIn: 'root' })
export class InstallPromptService {
  readonly canInstall = signal(false);
  readonly isStandalone = signal(this.detectStandalone());
  readonly isIos = signal(/iphone|ipad|ipod/i.test(navigator.userAgent));

  private deferredEvent: BeforeInstallPromptEvent | null = null;

  constructor() {
    window.addEventListener('beforeinstallprompt', (event: Event) => {
      event.preventDefault();
      this.deferredEvent = event as BeforeInstallPromptEvent;
      this.canInstall.set(true);
    });
    window.addEventListener('appinstalled', () => {
      this.canInstall.set(false);
      this.isStandalone.set(true);
      this.deferredEvent = null;
    });
  }

  async promptInstall(): Promise<void> {
    if (!this.deferredEvent) return;
    await this.deferredEvent.prompt();
    await this.deferredEvent.userChoice;
    this.deferredEvent = null;
    this.canInstall.set(false);
  }

  private detectStandalone(): boolean {
    const standaloneMedia = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
    const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
    return standaloneMedia || iosStandalone;
  }
}
