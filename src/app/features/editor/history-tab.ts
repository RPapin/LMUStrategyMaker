import { DatePipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { crewTotals } from '../../core/engine/assign';
import { StrategyVersion } from '../../core/models';
import { StrategyStore } from '../../core/strategy-store';
import { formatDuration, formatHours } from '../../core/util';

interface Summary {
  laps: number;
  totalSec: number;
  stops: number;
  tyres: string;
  crew: { name: string; color: string; sec: number }[];
}

@Component({
  selector: 'app-history-tab',
  imports: [FormsModule, DatePipe],
  template: `
    @if (rec(); as r) {
      @if (r.versions.length >= 2) {
        <div class="card">
          <div class="row" style="margin-bottom: 12px">
            <h3 style="margin: 0">Compare</h3>
            <select [ngModel]="a()" (ngModelChange)="a.set($event)">
              @for (v of newestFirst(); track v.id) { <option [ngValue]="v.number">v{{ v.number }} – {{ v.label }}</option> }
            </select>
            vs
            <select [ngModel]="b()" (ngModelChange)="b.set($event)">
              @for (v of newestFirst(); track v.id) { <option [ngValue]="v.number">v{{ v.number }} – {{ v.label }}</option> }
            </select>
          </div>
          @if (compare(); as c) {
            <table class="data">
              <thead><tr><th></th><th>v{{ c.a.number }}</th><th>v{{ c.b.number }}</th><th>Difference</th></tr></thead>
              <tbody>
                <tr><td>Laps</td><td class="num">{{ c.sa.laps }}</td><td class="num">{{ c.sb.laps }}</td><td class="num">{{ signed(c.sb.laps - c.sa.laps) }}</td></tr>
                <tr><td>Race time</td><td class="num">{{ dur(c.sa.totalSec) }}</td><td class="num">{{ dur(c.sb.totalSec) }}</td><td class="num">{{ dur(c.sb.totalSec - c.sa.totalSec) }}</td></tr>
                <tr><td>Pit stops</td><td class="num">{{ c.sa.stops }}</td><td class="num">{{ c.sb.stops }}</td><td class="num">{{ signed(c.sb.stops - c.sa.stops) }}</td></tr>
                <tr><td>Tyres used</td><td>{{ c.sa.tyres }}</td><td>{{ c.sb.tyres }}</td><td></td></tr>
                @for (name of c.names; track name) {
                  <tr>
                    <td>{{ name }}</td>
                    <td class="num">{{ crewTime(c.sa, name) }}</td>
                    <td class="num">{{ crewTime(c.sb, name) }}</td>
                    <td></td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>
      }

      <div class="card">
        <h3>Versions</h3>
        <p class="muted small">Every calculation is saved. Restoring copies an old version as a new one, nothing is lost.</p>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>#</th><th>Label</th><th>Note</th><th>Date</th><th>Laps</th><th>Stops</th><th>Race time</th><th>Crew</th><th></th></tr>
            </thead>
            <tbody>
              @for (v of newestFirst(); track v.id) {
                @let s = summary(v);
                <tr [class.current]="v.number === r.baseVersion">
                  <td class="num"><b>v{{ v.number }}</b></td>
                  <td><input [ngModel]="v.label" (ngModelChange)="store.updateVersionMeta(v, $event, v.note)" style="width: 170px" /></td>
                  <td><input [ngModel]="v.note" (ngModelChange)="store.updateVersionMeta(v, v.label, $event)" placeholder="note" style="width: 200px" /></td>
                  <td class="muted">{{ v.createdAt | date: 'short' }}</td>
                  <td class="num">{{ s?.laps ?? '—' }}</td>
                  <td class="num">{{ s?.stops ?? '—' }}</td>
                  <td class="num">{{ s ? dur(s.totalSec) : '—' }}</td>
                  <td>
                    @for (c of s?.crew ?? []; track c.name) {
                      <span class="chip" style="margin-right: 4px"><span class="dot" [style.background]="c.color"></span>{{ hm(c.sec) }}</span>
                    }
                  </td>
                  <td>
                    @if (v.number === r.baseVersion) {
                      <span class="muted small">current</span>
                    } @else {
                      <button class="btn sm" (click)="restore(v)">Restore</button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="9" class="muted">No version yet. Press "Calculate strategy".</td></tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    }
  `,
  styles: `tr.current td { background: color-mix(in srgb, var(--accent) 8%, transparent); }`,
})
export class HistoryTab {
  protected readonly store = inject(StrategyStore);
  readonly restored = output<void>();
  protected readonly rec = computed(() => this.store.current());
  protected readonly newestFirst = computed(() => [...(this.rec()?.versions ?? [])].reverse());
  protected readonly dur = formatDuration;
  protected readonly hm = formatHours;

  protected readonly a = signal<number | null>(null);
  protected readonly b = signal<number | null>(null);

  private readonly cache = new WeakMap<StrategyVersion, Summary | null>();

  constructor() {
    const v = this.rec()?.versions ?? [];
    if (v.length >= 2) {
      this.a.set(v[v.length - 2].number);
      this.b.set(v[v.length - 1].number);
    }
  }

  protected readonly compare = computed(() => {
    const versions = this.rec()?.versions ?? [];
    const a = versions.find((v) => v.number === this.a());
    const b = versions.find((v) => v.number === this.b());
    if (!a || !b) return null;
    const sa = this.summary(a);
    const sb = this.summary(b);
    if (!sa || !sb) return null;
    const names = [...new Set([...sa.crew, ...sb.crew].map((c) => c.name))];
    return { a, b, sa, sb, names };
  });

  summary(v: StrategyVersion): Summary | null {
    if (this.cache.has(v)) return this.cache.get(v)!;
    let s: Summary | null = null;
    if (v.plan) {
      const totals = crewTotals(v.inputs, v.plan);
      s = {
        laps: v.plan.totalLaps,
        totalSec: v.plan.totalSec,
        stops: v.plan.stops,
        tyres: Object.entries(v.plan.tyresUsed).map(([k, n]) => `${k} ${n}`).join(', '),
        crew: v.inputs.drivers.map((d, i) => ({ name: d.name, color: d.color, sec: totals[i].driveSec })),
      };
    }
    this.cache.set(v, s);
    return s;
  }

  crewTime(s: Summary, name: string): string {
    const c = s.crew.find((x) => x.name === name);
    return c ? formatHours(c.sec) : '—';
  }

  signed(n: number): string {
    return n > 0 ? `+${n}` : String(n);
  }

  restore(v: StrategyVersion): void {
    this.store.restore(v);
    this.restored.emit();
  }
}
