import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { emptyOverride } from '../../core/defaults';
import {
  availabilityMatrix,
  crewIssues,
  crewTotals,
  emptyAssignment,
  setAvailability,
  stintRealRange,
} from '../../core/engine/assign';
import { finishGapSec, lockedCount, tyreLimit } from '../../core/engine/strategy';
import { Availability, Driver, Stint, StintAssignment, StintOverride, TyreCompound } from '../../core/models';
import { StrategyStore } from '../../core/strategy-store';
import { clockAt, clockSecAt, formatDuration, formatHours, formatLap, raceSecAt } from '../../core/util';

interface PitInEdit {
  j: number;
  time: string;
  laps: number;
}

/** Columns of the stints table that can be hidden. */
const COLUMNS = [
  { key: 'laps', label: 'Laps' },
  { key: 'time', label: 'Time' },
  { key: 'length', label: 'Length' },
  { key: 'avg', label: 'Avg lap' },
  { key: 'tyres', label: 'Tyres' },
  { key: 've', label: 'VE' },
  { key: 'stop', label: 'Stop after' },
  { key: 'pit', label: 'Pit in' },
  { key: 'driver', label: 'Driver' },
  { key: 'spotter', label: 'Spotter' },
  { key: 'avail', label: 'Availability' },
  { key: 'overrides', label: 'Overrides' },
];

const HIDDEN_KEY = 'sm-hidden-columns';

function readHidden(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

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
  /** Stints already run (race mode). */
  protected readonly locked = computed(() => {
    const p = this.rec()?.plan;
    return p ? lockedCount(p) : 0;
  });
  /** Race mode: how far the shifted plan finishes from the clock. */
  protected readonly finishGap = computed(() => {
    const c = this.ctx();
    return c?.p.live ? finishGapSec(c.d, c.p) : null;
  });
  protected readonly pitEdit = signal<PitInEdit | null>(null);
  /** Tyres of the fitted compound left for the race after each stint's tyre change. */
  protected readonly tyresLeft = computed(() => {
    const r = this.rec();
    if (!r?.plan) return [];
    const used = new Map<string, number>();
    const byId = new Map(r.draft.tyres.map((t) => [t.id, t]));
    return r.plan.stints.map((s) => {
      used.set(s.compoundId, (used.get(s.compoundId) ?? 0) + s.tyreChange);
      const t = byId.get(s.compoundId);
      if (!t) return '?';
      const limit = tyreLimit(t);
      return isFinite(limit) ? String(limit - used.get(s.compoundId)!) : '∞';
    });
  });

  protected readonly columns = COLUMNS;
  /** Hidden columns, remembered in this browser. */
  protected readonly hidden = signal(new Set(readHidden()));
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

  setDriver(j: number, id: string | null): void {
    const a = this.assignment(j);
    a.driverId = id;
    a.driverLocked = id != null;
    if (a.spotterId === id) a.spotterId = null;
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
    if (kind === 'driver') a.driverLocked = !a.driverLocked;
    else a.spotterLocked = !a.spotterLocked;
    this.store.touch(false);
  }

  unlockAll(): void {
    // the crew of stints already run stays locked
    for (const a of this.draft()!.assignments.slice(this.locked())) {
      a.driverLocked = false;
      a.spotterLocked = false;
    }
    this.store.touch(false);
  }

  cycleAvailability(j: number, drv: Driver): void {
    const [from, to] = stintRealRange(this.draft()!, this.plan()!, j);
    setAvailability(drv, from, to, NEXT_STATUS[this.avail()[j][this.draft()!.drivers.indexOf(drv)]]);
    this.store.availabilityChanged(drv);
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

  show(key: string): boolean {
    return !this.hidden().has(key);
  }

  toggleColumn(key: string): void {
    const next = new Set(this.hidden());
    if (!next.delete(key)) next.add(key);
    this.saveHidden(next);
  }

  showAllColumns(): void {
    this.saveHidden(new Set());
  }

  private saveHidden(hidden: Set<string>): void {
    this.hidden.set(hidden);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
    } catch {
      // storage unavailable: the choice only lasts for this page
    }
  }

  tyreMax(t: TyreCompound): string {
    const n = tyreLimit(t);
    return isFinite(n) ? String(n) : '∞';
  }

  /** Only the last stint run and the ones after it can still get a real pit-in time. */
  canPitIn(j: number): boolean {
    return j >= this.locked() - 1;
  }

  openPitIn(s: Stint): void {
    this.pitEdit.set({ j: s.index, time: clockSecAt(this.draft()!.race.startTime, s.endSec), laps: s.laps });
  }

  private pitSec(e: PitInEdit): number {
    return raceSecAt(this.draft()!.race.startTime, e.time, this.plan()!.stints[e.j].endSec);
  }

  /** New pit-in time: estimate the laps run from the stint's average lap. */
  pitTimeChanged(e: PitInEdit, time: string): void {
    const s = this.plan()!.stints[e.j];
    const next = { ...e, time };
    const sec = this.pitSec(next);
    if (sec > s.startSec && s.avgLapSec > 0) next.laps = Math.max(1, Math.round((sec - s.startSec) / s.avgLapSec));
    this.pitEdit.set(next);
  }

  pitNow(e: PitInEdit): void {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    this.pitTimeChanged(e, `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
  }

  pitPreview(e: PitInEdit): string {
    const sec = this.pitSec(e);
    if (isNaN(sec)) return 'Invalid time';
    const s = this.plan()!.stints[e.j];
    const delta = sec - s.endSec;
    return `${delta >= 0 ? '+' : '−'}${this.dur(Math.abs(delta))} vs plan · race clock ${this.dur(sec)}`;
  }

  savePitIn(e: PitInEdit): void {
    const sec = this.pitSec(e);
    if (isNaN(sec)) return;
    if (this.store.pitIn(e.j, sec, Math.round(e.laps))) this.pitEdit.set(null);
  }
}
