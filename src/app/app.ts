import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { Supabase } from './core/cloud/supabase';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <header class="top">
      <a routerLink="/" class="brand"><span class="flag"></span>LMU Strategy Maker</a>
      <span class="spacer"></span>
      @if (sb.configured && sb.ready()) {
        @if (sb.user()) {
          <span class="row small">
            <input
              class="name"
              [value]="sb.profile()?.display_name ?? ''"
              (change)="sb.updateDisplayName($any($event.target).value)"
              title="Your name shown to the team"
            />
            <button class="btn sm ghost" (click)="signOut()">Sign out</button>
          </span>
        } @else {
          <a class="btn sm" routerLink="/login">Sign in</a>
        }
      }
    </header>
    <router-outlet />
  `,
  styles: `
    .top { display: flex; align-items: center; height: 52px; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .brand { color: var(--text); text-decoration: none; font-weight: 700; letter-spacing: .02em; display: flex; align-items: center; gap: 10px; }
    .name { background: transparent; border-color: transparent; width: 160px; text-align: right; }
    .name:hover, .name:focus { border-color: var(--border); }
    .flag { width: 18px; height: 18px; border-radius: 3px; background: conic-gradient(#fff 0 25%, #111 0 50%, #fff 0 75%, #111 0) 0 0 / 9px 9px; }
  `,
})
export class App {
  protected readonly sb = inject(Supabase);
  private readonly router = inject(Router);

  async signOut(): Promise<void> {
    await this.sb.signOut();
    this.router.navigate(['/']);
  }
}
