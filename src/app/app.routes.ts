import { Routes } from '@angular/router';
import { authGuard } from './core/cloud/auth-guard';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/home/home').then((m) => m.Home) },
  { path: 'login', loadComponent: () => import('./features/auth/login').then((m) => m.Login) },
  { path: 'join/:code', canActivate: [authGuard], loadComponent: () => import('./features/team/join').then((m) => m.Join) },
  { path: 'team/:teamId', canActivate: [authGuard], loadComponent: () => import('./features/team/team').then((m) => m.TeamPage) },
  {
    path: 'team/:teamId/strategy/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./features/editor/editor').then((m) => m.Editor),
  },
  { path: 'strategy/:id', loadComponent: () => import('./features/editor/editor').then((m) => m.Editor) },
  { path: '**', redirectTo: '' },
];
