import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { StrategyStore } from '../../core/strategy-store';

@Component({
  selector: 'app-home',
  imports: [FormsModule, DatePipe, RouterLink],
  template: `
    <div class="page">
      @if (error()) {
        <div class="alert error">{{ error() }}</div>
      }

      <div class="card">
        <h2>New strategy</h2>
        <div class="row">
          <input [(ngModel)]="name" placeholder="e.g. Spa 6h – Hypercar" (keyup.enter)="create()" style="width: 320px" />
          @if (store.sharingAvailable) {
            <button class="btn primary" [disabled]="busy()" (click)="createShared()">Create shared strategy</button>
            <button class="btn" (click)="create()">Create local only</button>
          } @else {
            <button class="btn primary" (click)="create()">Create</button>
          }
          <span class="spacer"></span>
          <label class="btn">
            Import JSON
            <input type="file" accept=".json,application/json" hidden (change)="importFile($event)" />
          </label>
        </div>
        @if (store.sharingAvailable) {
          <p class="muted small" style="margin: 10px 0 0">
            A shared strategy gets a secret link: anyone with the link can see and edit it, no account needed.
          </p>
        }
      </div>

      @if (store.sharingAvailable) {
        <div class="card">
          <h2>Shared strategies</h2>
          @if (store.shared().length) {
            <table class="data">
              <thead><tr><th>Name</th><th>Last opened</th><th></th></tr></thead>
              <tbody>
                @for (s of store.shared(); track s.token) {
                  <tr>
                    <td><a [routerLink]="['/s', s.token]">{{ s.name }}</a></td>
                    <td class="muted">{{ s.openedAt | date: 'short' }}</td>
                    <td style="text-align: right">
                      <button class="btn sm" (click)="copy(s.token)">{{ copied() === s.token ? 'Link copied' : 'Copy link' }}</button>
                      <button class="btn sm ghost" (click)="store.forgetShared(s.token)" title="Only removes it from this list">
                        Remove from list
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted small">Shared strategies you create or open from a link show up here.</p>
          }
        </div>
      }

      <div class="card">
        <h2>Local strategies</h2>
        <p class="muted small" style="margin-top: -6px">Stored in this browser only.</p>
        @if (store.list().length) {
          <table class="data">
            <thead>
              <tr><th>Name</th><th>Versions</th><th>Updated</th><th></th></tr>
            </thead>
            <tbody>
              @for (s of store.list(); track s.id) {
                <tr>
                  <td><a [routerLink]="['/strategy', s.id]">{{ s.name }}</a></td>
                  <td class="num">{{ s.versions.length }}</td>
                  <td class="muted">{{ s.updatedAt | date: 'short' }}</td>
                  <td style="text-align: right">
                    @if (store.sharingAvailable) {
                      <button class="btn sm" [disabled]="busy()" (click)="share(s.id)" title="Copies it to a share link, the local copy is kept">
                        Share
                      </button>
                    }
                    <button class="btn sm" (click)="store.duplicate(s.id)">Duplicate</button>
                    @if (confirmDelete() === s.id) {
                      <button class="btn sm danger" (click)="store.remove(s.id)">Confirm delete</button>
                      <button class="btn sm ghost" (click)="confirmDelete.set(null)">Cancel</button>
                    } @else {
                      <button class="btn sm danger" (click)="confirmDelete.set(s.id)">Delete</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="muted small">No local strategy.</p>
        }
      </div>
    </div>
  `,
})
export class Home implements OnInit {
  protected readonly store = inject(StrategyStore);
  private readonly router = inject(Router);
  protected name = '';
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly copied = signal<string | null>(null);
  protected readonly confirmDelete = signal<string | null>(null);

  ngOnInit(): void {
    this.store.refreshList();
  }

  async create(): Promise<void> {
    const rec = await this.store.create(this.name.trim());
    this.router.navigate(['/strategy', rec.id]);
  }

  async createShared(): Promise<void> {
    await this.run(async () => {
      const token = await this.store.createShared(this.name.trim());
      this.router.navigate(['/s', token]);
    });
  }

  async share(localId: string): Promise<void> {
    await this.run(async () => {
      const token = await this.store.share(localId);
      this.router.navigate(['/s', token]);
    });
  }

  async copy(token: string): Promise<void> {
    await navigator.clipboard.writeText(this.store.shareUrl(token));
    this.copied.set(token);
    setTimeout(() => this.copied.set(null), 1500);
  }

  async importFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await this.run(async () => {
      const rec = await this.store.import(await file.text());
      this.router.navigate(['/strategy', rec.id]);
    });
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
