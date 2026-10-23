import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Supabase } from '../../core/cloud/supabase';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="page narrow">
      <div class="card">
        <h2>Sign in</h2>
        @if (!sb.configured) {
          <p class="muted">Team features are not configured (see <code>src/environments/environment.ts</code>).</p>
        } @else if (sent()) {
          <p>Check your inbox: we sent a sign-in link to <b>{{ email }}</b>.</p>
          <button class="btn ghost" (click)="sent.set(false)">Use another email</button>
        } @else {
          <p class="muted small">Sign in to share strategies with your team and set your availability.</p>
          <div class="field">
            Email
            <input type="email" [(ngModel)]="email" placeholder="you@example.com" (keyup.enter)="sendLink()" />
          </div>
          <div class="row" style="margin-top: 12px">
            <button class="btn primary" [disabled]="busy() || !email" (click)="sendLink()">Send magic link</button>
            <span class="muted small">or</span>
            <button class="btn" [disabled]="busy()" (click)="discord()">Continue with Discord</button>
          </div>
        }
        @if (error()) {
          <div class="alert error" style="margin: 12px 0 0">{{ error() }}</div>
        }
      </div>
    </div>
  `,
  styles: `.narrow { max-width: 480px; margin-top: 40px; }`,
})
export class Login implements OnInit {
  protected readonly sb = inject(Supabase);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected email = '';
  protected readonly sent = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private get next(): string {
    const n = this.route.snapshot.queryParamMap.get('next');
    return n && n.startsWith('/') ? n : '/';
  }

  async ngOnInit(): Promise<void> {
    await this.sb.whenReady();
    if (this.sb.user()) this.router.navigateByUrl(this.next);
  }

  async sendLink(): Promise<void> {
    await this.run(async () => {
      await this.sb.signInWithEmail(this.email.trim(), this.next);
      this.sent.set(true);
    });
  }

  async discord(): Promise<void> {
    await this.run(() => this.sb.signInWithDiscord(this.next));
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
    this.busy.set(false);
  }
}
