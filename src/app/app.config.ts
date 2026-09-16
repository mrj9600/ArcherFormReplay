import { ApplicationConfig, provideAppInitializer, provideBrowserGlobalErrorListeners, inject, isDevMode } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { provideServiceWorker } from '@angular/service-worker';
import { InstallPromptService } from './services/install-prompt.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    // Constructed eagerly so its `beforeinstallprompt` listener is attached before the event can fire.
    provideAppInitializer(() => {
      inject(InstallPromptService);
    }),
  ],
};
