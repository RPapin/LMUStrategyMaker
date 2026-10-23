import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/home/home').then((m) => m.Home) },
  { path: 'strategy/:id', loadComponent: () => import('./features/editor/editor').then((m) => m.Editor) },
  { path: '**', redirectTo: '' },
];
