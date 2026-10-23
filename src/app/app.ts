import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <header class="top">
      <a routerLink="/" class="brand"><span class="flag"></span>LMU Strategy Maker</a>
    </header>
    <router-outlet />
  `,
  styles: `
    .top { display: flex; align-items: center; height: 52px; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .brand { color: var(--text); text-decoration: none; font-weight: 700; letter-spacing: .02em; display: flex; align-items: center; gap: 10px; }
    .flag { width: 18px; height: 18px; border-radius: 3px; background: conic-gradient(#fff 0 25%, #111 0 50%, #fff 0 75%, #111 0) 0 0 / 9px 9px; }
  `,
})
export class App {}
