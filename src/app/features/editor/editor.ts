import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { StrategyStore } from '../../core/strategy-store';
import { DriversTab } from './drivers-tab';
import { HistoryTab } from './history-tab';
import { MyAvailabilityTab } from './my-availability-tab';
import { PlanTab } from './plan-tab';
import { SetupTab } from './setup-tab';

type Tab = 'setup' | 'drivers' | 'plan' | 'history' | 'me';

@Component({
  selector: 'app-editor',
  imports: [FormsModule, RouterLink, SetupTab, DriversTab, PlanTab, HistoryTab, MyAvailabilityTab],
  template: `
    @if (store.current(); as rec) {
      <div class="page">
        <div class="row head">
          <a routerLink="/" class="muted">← Home</a>
          <input class="title" [ngModel]="rec.name" (ngModelChange)="store.rename($event)" />
          <span class="muted small">
            {{ store.saving() ? 'Saving…' : 'Saved' }}{{ rec.shareToken ? ' · shared' : ' · local' }}
            @if (rec.baseVersion) { · based on v{{ rec.baseVersion }} }
          </span>
          <span class="spacer"></span>
          @if (rec.dirty && rec.plan) {
            <span class="chip" style="color: var(--warn)">Inputs changed – recalculate</span>
          }
          @if (rec.shareToken) {
            <button class="btn" (click)="copyLink(rec.shareToken)" title="Anyone with this link can see and edit the strategy">
              {{ copied() ? 'Link copied' : 'Copy share link' }}
            </button>
          }
          <button class="btn" (click)="exportJson()">Export</button>
          <button class="btn" [disabled]="!rec.plan" (click)="store.saveVersion('Manual save')">Save version</button>
          <button class="btn primary" (click)="calculate()">Calculate strategy</button>
        </div>

        @if (store.error()) {
          <div class="alert error row">
            {{ store.error() }}
            <span class="spacer"></span>
            <button class="btn sm ghost" (click)="store.error.set(null)">✕</button>
          </div>
        }
        @if (store.notice()) {
          <div class="alert warn row">
            {{ store.notice() }}
            <span class="spacer"></span>
            <button class="btn sm ghost" (click)="store.notice.set(null)">✕</button>
          </div>
        }

        <nav class="tabs">
          @if (store.isShared()) {
            <button [class.active]="tab() === 'me'" (click)="tab.set('me')">My availability</button>
          }
          <button [class.active]="tab() === 'plan'" (click)="tab.set('plan')">Strategy</button>
          <button [class.active]="tab() === 'setup'" (click)="tab.set('setup')">Race setup</button>
          <button [class.active]="tab() === 'drivers'" (click)="tab.set('drivers')">Drivers ({{ rec.draft.drivers.length }})</button>
          <button [class.active]="tab() === 'history'" (click)="tab.set('history')">History ({{ rec.versions.length }})</button>
        </nav>

        @if (tab() === 'me') {
          <app-my-availability-tab />
        } @else {
          @switch (tab()) {
            @case ('setup') { <app-setup-tab /> }
            @case ('drivers') { <app-drivers-tab /> }
            @case ('plan') { <app-plan-tab (goSetup)="tab.set('setup')" /> }
            @case ('history') { <app-history-tab (restored)="tab.set('plan')" /> }
          }
        }
      </div>
    } @else if (notFound()) {
      <div class="page">
        <div class="card">
          Strategy not found.
          @if (store.error()) { <div class="alert error" style="margin: 12px 0 0">{{ store.error() }}</div> }
        </div>
      </div>
    }
  `,
  styles: `
    .head { margin-bottom: 16px; }
    .title { font-size: 18px; font-weight: 600; background: transparent; border-color: transparent; width: 360px; }
    .title:hover:not(:disabled), .title:focus { border-color: var(--border); }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; overflow-x: auto; }
    .tabs button { background: none; border: none; color: var(--muted); padding: 10px 14px; font: inherit; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; }
    .tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
  `,
})
export class Editor implements OnInit, OnDestroy {
  protected readonly store = inject(StrategyStore);
  private readonly route = inject(ActivatedRoute);
  protected readonly tab = signal<Tab>('setup');
  protected readonly notFound = signal(false);
  protected readonly copied = signal(false);

  async ngOnInit(): Promise<void> {
    const token = this.route.snapshot.paramMap.get('token');
    const ok = await this.store.load(token ?? this.route.snapshot.paramMap.get('id')!, !!token);
    this.notFound.set(!ok);
    if (ok && this.store.current()?.plan) this.tab.set('plan');
  }

  async copyLink(token: string): Promise<void> {
    await navigator.clipboard.writeText(this.store.shareUrl(token));
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  ngOnDestroy(): void {
    this.store.close();
  }

  calculate(): void {
    if (this.store.calculate()) this.tab.set('plan');
  }

  exportJson(): void {
    const rec = this.store.current();
    if (!rec) return;
    const blob = new Blob([this.store.export(rec)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${rec.name.replace(/[^\w\- ]+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
