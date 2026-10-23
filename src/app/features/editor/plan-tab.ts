import { Component, computed, inject, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { emptyOverride } from '../../core/defaults';
import {
  availabilityMatrix,
  crewIssues,
  crewTotals,
  emptyAssignment,
  setAvailability,
  stintRealRange,
  tyreBlocks,
} from '../../core/engine/assign';
import { Availability, Driver, Stint, StintAssignment, StintOverride } from '../../core/models';
import { StrategyStore } from '../../core/strategy-store';
import { clockAt, formatDuration, formatHours, formatLap } from '../../core/util';

const NEXT_STATUS: Record<Availability, Availability> = {
  available: 'preferred',
  preferred: 'unavailable',
  unavailable: 'available',
};

@Component({
  selector: 'app-plan-tab',
  imports: [FormsModule],
  templateUrl: './plan-tab.html',
  styleUrl: './plan-tab.scss',
})
export class PlanTab {
  protected readonly store = inject(StrategyStore);
  readonly goSetup = output<void>();

  protected readonly rec = computed(() => this.store.current());
  protected readonly draft = computed(() => this.rec()?.draft ?? null);
  protected readonly plan = computed(() => this.rec()?.plan ?? null);
  // Derived views read rec() itself: draft/plan are mutated in place, only the record identity changes.
  protected readonly drivers = computed(() => new Map((this.rec()?.draft.drivers ?? []).map((d) => [d.id, d])));
  private readonly ctx = computed(() => {
    const r = this.rec();
    return r?.plan ? { d: r.draft, p: r.plan } : null;
  });
  protected readonly avail = computed(() => {
    const c = this.ctx();
    return c ? availabilityMatrix(c.d, c.p) : [];
  });
  protected readonly totals = computed(() => {
    const c = this.ctx();
    return c ? crewTotals(c.d, c.p) : [];
  });
  protected readonly issues = computed(() => {
    const c = this.ctx();
    return c ? crewIssues(c.d, c.p) : [];
  });
  protected readonly blocks = computed(() => {
    const p = this.plan();
    return p ? tyreBlocks(p) : [];
  });
  protected readonly hours = computed(() => {
    const p = this.plan();
    return p ? Array.from({ length: Math.floor(p.totalSec / 3600) + 1 }, (_, h) => h) : [];
  });

  protected readonly Math = Math;
  protected readonly lap = formatLap;
  protected readonly dur = formatDuration;
  protected readonly hm = formatHours;

  clock(sec: number, withDay = false): string {
    return clockAt(this.draft()!.race.startTime, sec, withDay);
  }

  pct(sec: number): number {
    return (sec / this.plan()!.totalSec) * 100;
  }

  driver(id: string | null | undefined): Driver | undefined {
    return id ? this.drivers().get(id) : undefined;
  }

  assignment(j: number): StintAssignment {
    const d = this.draft()!;
    return (d.assignments[j] ??= emptyAssignment());
  }

  override(j: number): StintOverride {
    const d = this.draft()!;
    return (d.overrides[j] ??= emptyOverride());
  }

  hasOverride(j: number): boolean {
    const o = this.draft()!.overrides[j];
    return !!o && (!!o.lockedLaps || o.tyreAction !== 'auto' || !!o.compoundId);
  }

  tyreLabel(s: Stint): string {
    if (s.tyreChange === 4) return `${s.compoundName} · 4 new`;
    if (s.tyreChange === 2) return `${s.compoundName} · 2 new + 2 at ${s.tyreAgeOld}L`;
    return `${s.compoundName} · used ${s.tyreAgeOld}/${s.tyreAgeNew}L`;
  }

  stopTitle(s: Stint): string {
    const st = s.stop;
    if (!st) return '';
    return [
      `Pit lane ${st.laneSec.toFixed(1)}s`,
      `Refuel ${st.refuelPct.toFixed(1)}% → ${st.refuelSec.toFixed(1)}s`,
      st.tyreCount ? `${st.tyreCount} tyres ${st.tyreSec.toFixed(1)}s` : 'No tyres',
      st.driverChange ? `Driver change ${st.driverSec.toFixed(1)}s` : 'Same driver',
      `Service ${st.serviceSec.toFixed(1)}s`,
    ].join('\n');
  }

  /** Stints sharing a set of tyres, hence the same driver. */
  private block(j: number): number[] {
    const [from, to] = this.blocks().find(([f, t]) => j >= f && j <= t) ?? [j, j];
    return Array.from({ length: to - from + 1 }, (_, k) => from + k);
  }

  setDriver(j: number, id: string | null): void {
    for (const k of this.block(j)) {
      const a = this.assignment(k);
      a.driverId = id;
      a.driverLocked = id != null;
      if (a.spotterId === id) a.spotterId = null;
    }
    this.store.crewChanged();
  }

  setSpotter(j: number, id: string | null): void {
    const a = this.assignment(j);
    a.spotterId = id;
    a.spotterLocked = id != null;
    this.store.crewChanged();
  }

  toggleLock(j: number, kind: 'driver' | 'spotter'): void {
    const a = this.assignment(j);
    if (kind === 'driver') {
      const lock = !a.driverLocked;
      for (const k of this.block(j)) this.assignment(k).driverLocked = lock;
    } else a.spotterLocked = !a.spotterLocked;
    this.store.touch(false);
  }

  unlockAll(): void {
    for (const a of this.draft()!.assignments) {
      a.driverLocked = false;
      a.spotterLocked = false;
    }
    this.store.touch(false);
  }

  cycleAvailability(j: number, drv: Driver): void {
    const [from, to] = stintRealRange(this.draft()!, this.plan()!, j);
    setAvailability(drv, from, to, NEXT_STATUS[this.avail()[j][this.draft()!.drivers.indexOf(drv)]]);
    this.store.touch(false);
  }

  overrideChanged(): void {
    this.store.touch();
  }

  clearOverride(j: number): void {
    this.draft()!.overrides[j] = emptyOverride();
    this.store.touch();
  }

  setsLeft(name: string, sets: number): number {
    return sets - (this.plan()!.tyresUsed[name] ?? 0);
  }
}
