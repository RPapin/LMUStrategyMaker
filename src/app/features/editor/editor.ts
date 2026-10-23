import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { StrategyStore } from '../../core/strategy-store';
import { DriversTab } from './drivers-tab';
import { HistoryTab } from './history-tab';
import { PlanTab } from './plan-tab';
import { SetupTab } from './setup-tab';

type Tab = 'setup' | 'drivers' | 'plan' | 'history';

@Component({
  selector: 'app-editor',
  imports: [FormsModule, SetupTab, DriversTab, PlanTab, HistoryTab],
  template: `
    @if (store.current(); as rec) {
      <div class="page">
        <div class="row head">
          <input class="title" [ngModel]="rec.name" (ngModelChange)="store.rename($event)" />
          <span class="muted small">
            {{ store.saving() ? 'Saving…' : 'Saved' }}
            @if (rec.baseVersion) { · based on v{{ rec.baseVersion }} }
          </span>
          <span class="spacer"></span>
          @if (rec.dirty && rec.plan) {
            <span class="chip" style="color: var(--warn)">Inputs changed – recalculate</span>
          }
          <button class="btn" (click)="exportJson()">Export</button>
          <button class="btn" [disabled]="!rec.plan" (click)="saveVersion()">Save version</button>
          <button class="btn primary" (click)="calculate()">Calculate strategy</button>
        </div>

        @if (store.error()) {
          <div class="alert error">{{ store.error() }}</div>
        }

        <nav class="tabs">
          <button [class.active]="tab() === 'setup'" (click)="tab.set('setup')">Race setup</button>
          <button [class.active]="tab() === 'drivers'" (click)="tab.set('drivers')">Drivers ({{ rec.draft.drivers.length }})</button>
          <button [class.active]="tab() === 'plan'" (click)="tab.set('plan')">Strategy</button>
          <button [class.active]="tab() === 'history'" (click)="tab.set('history')">History ({{ rec.versions.length }})</button>
        </nav>

        @switch (tab()) {
          @case ('setup') { <app-setup-tab /> }
          @case ('drivers') { <app-drivers-tab /> }
          @case ('plan') { <app-plan-tab (goSetup)="tab.set('setup')" /> }
          @case ('history') { <app-history-tab (restored)="tab.set('plan')" /> }
        }
      </div>
    } @else if (notFound()) {
      <div class="page"><div class="card">Strategy not found.</div></div>
    }
  `,
  styles: `
    .head { margin-bottom: 16px; }
    .title { font-size: 18px; font-weight: 600; background: transparent; border-color: transparent; width: 360px; }
    .title:hover, .title:focus { border-color: var(--border); }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; overflow-x: auto; }
    .tabs button { background: none; border: none; color: var(--muted); padding: 10px 14px; font: inherit; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; }
    .tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
  `,
})
export class Editor implements OnInit {
  protected readonly store = inject(StrategyStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly tab = signal<Tab>('setup');
  protected readonly notFound = signal(false);

  async ngOnInit(): Promise<void> {
    const ok = await this.store.load(this.route.snapshot.paramMap.get('id')!);
    this.notFound.set(!ok);
    if (ok && this.store.current()?.plan) this.tab.set('plan');
  }

  calculate(): void {
    if (this.store.calculate()) this.tab.set('plan');
  }

  saveVersion(): void {
    this.store.saveVersion('Manual save');
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
