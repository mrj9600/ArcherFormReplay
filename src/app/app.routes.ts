import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  { path: 'home', loadComponent: () => import('./pages/home/home').then((m) => m.Home) },
  { path: 'record', loadComponent: () => import('./pages/record/record').then((m) => m.Record) },
  { path: 'review', loadComponent: () => import('./pages/review/review').then((m) => m.Review) },
  { path: 'session', loadComponent: () => import('./pages/session/session').then((m) => m.Session) },
  { path: 'settings', loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings) },
  { path: 'sync-clock', loadComponent: () => import('./pages/sync-clock/sync-clock').then((m) => m.SyncClock) },
  { path: '**', redirectTo: 'home' },
];
