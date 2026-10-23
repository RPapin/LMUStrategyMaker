import { Injectable, signal } from '@angular/core';
import { db } from './db';
import { defaultInputs, tyresForCategory } from './defaults';
import { assignCrew } from './engine/assign';
import { computeStrategy, retime } from './engine/strategy';
import { StrategyInputs, StrategyRecord, StrategyVersion } from './models';
import { clone, uid } from './util';

/** Brings records saved by older app versions up to date. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Legacy = any;

function migrateInputs(inp: StrategyInputs): void {
  const race: Legacy = inp.race;
  if (!race.category) {
    race.category = 'hypercar';
    inp.tyres = tyresForCategory('hypercar', inp.tyres);
  }
  // tyre sets -> individual tyres, single tyre change time -> 4 / 2 tyres
  for (const t of inp.tyres as Legacy[]) {
    if (t.tyres == null) t.tyres = (t.sets ?? 0) * 4;
    delete t.sets;
  }
  if (race.tyreChange4Sec == null) {
    race.tyreChange4Sec = race.tyreChangeSec ?? 13;
    race.tyreChange2Sec = 6;
    delete race.tyreChangeSec;
  }
  for (const o of inp.overrides as Legacy[]) if (o?.tyreAction === 'fresh') o.tyreAction = 'four';
}

function migratePlan(plan: Legacy): void {
  if (!plan || plan.tyresUsed) return;
  plan.tyresUsed = Object.fromEntries(Object.entries(plan.setsUsed ?? {}).map(([k, n]) => [k, (n as number) * 4]));
  for (const s of plan.stints) {
    s.tyreChange = s.tyreFresh ? 4 : 0;
    s.tyreAgeOld = s.tyreAgeNew = s.tyreAgeStart ?? 0;
    if (s.stop) s.stop.tyreCount = s.stop.tyres ? 4 : 0;
  }
}

function migrate(rec: StrategyRecord): void {
  migrateInputs(rec.draft);
  migratePlan(rec.plan);
  rec.versions.forEach((v) => {
    migrateInputs(v.inputs);
    migratePlan(v.plan);
  });
}

@Injectable({ providedIn: 'root' })
export class StrategyStore {
  readonly list = signal<StrategyRecord[]>([]);
  readonly current = signal<StrategyRecord | null>(null);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async refreshList(): Promise<void> {
    const all = await db.all();
    this.list.set(all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async create(name: string): Promise<StrategyRecord> {
    const now = new Date().toISOString();
    const rec: StrategyRecord = {
      id: uid(),
      name: name || 'New strategy',
      createdAt: now,
      updatedAt: now,
      draft: defaultInputs(),
      plan: null,
      baseVersion: null,
      dirty: true,
      versions: [],
    };
    await db.put(rec);
    await this.refreshList();
    return rec;
  }

  async duplicate(id: string): Promise<StrategyRecord | null> {
    const src = await db.get(id);
    if (!src) return null;
    const now = new Date().toISOString();
    const rec: StrategyRecord = { ...clone(src), id: uid(), name: `${src.name} (copy)`, createdAt: now, updatedAt: now };
    await db.put(rec);
    await this.refreshList();
    return rec;
  }

  async remove(id: string): Promise<void> {
    await db.delete(id);
    if (this.current()?.id === id) this.current.set(null);
    await this.refreshList();
  }

  async load(id: string): Promise<boolean> {
    const rec = await db.get(id);
    if (rec) migrate(rec);
    this.current.set(rec ?? null);
    this.error.set(null);
    return !!rec;
  }

  async import(json: string): Promise<StrategyRecord> {
    const rec = JSON.parse(json) as StrategyRecord;
    if (!rec?.draft?.race || !Array.isArray(rec.versions)) throw new Error('Not a strategy file.');
    migrate(rec);
    rec.id = uid();
    rec.updatedAt = new Date().toISOString();
    await db.put(rec);
    await this.refreshList();
    return rec;
  }

  export(rec: StrategyRecord): string {
    return JSON.stringify(rec, null, 2);
  }

  /** Inputs were edited: mark the plan stale and autosave. */
  touch(inputsChanged = true): void {
    const rec = this.current();
    if (!rec) return;
    if (inputsChanged) rec.dirty = true;
    this.current.set({ ...rec });
    this.scheduleSave();
  }

  /** Manual crew edit: no recalculation, only re-timing of the stops. */
  crewChanged(): void {
    const rec = this.current();
    if (!rec?.plan) return;
    rec.plan = retime(rec.plan, rec.draft);
    this.touch(false);
  }

  /** Full recalculation (stints + crew), saved as a new version. */
  calculate(label = 'Recalculated'): boolean {
    const rec = this.current();
    if (!rec) return false;
    try {
      let plan = computeStrategy(rec.draft);
      rec.draft.assignments = assignCrew(rec.draft, plan);
      rec.draft.overrides = rec.draft.overrides.slice(0, plan.stints.length);
      plan = retime(plan, rec.draft);
      rec.plan = plan;
      rec.dirty = false;
      this.error.set(null);
      this.pushVersion(rec, label);
      return true;
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  /** Re-balance only the crew on the current stints, saved as a new version. */
  rebalanceCrew(): void {
    const rec = this.current();
    if (!rec?.plan) return;
    rec.draft.assignments = assignCrew(rec.draft, rec.plan);
    rec.plan = retime(rec.plan, rec.draft);
    this.pushVersion(rec, 'Crew re-balanced');
  }

  saveVersion(label: string): void {
    const rec = this.current();
    if (rec) this.pushVersion(rec, label || 'Manual save');
  }

  /** Restoring never deletes anything: the old version is copied as a new one. */
  restore(version: StrategyVersion): void {
    const rec = this.current();
    if (!rec) return;
    rec.draft = clone(version.inputs);
    rec.plan = clone(version.plan);
    rec.dirty = false;
    this.pushVersion(rec, `Restored from v${version.number}`);
  }

  updateVersionMeta(version: StrategyVersion, label: string, note: string): void {
    version.label = label;
    version.note = note;
    this.touch(false);
  }

  rename(name: string): void {
    const rec = this.current();
    if (!rec) return;
    rec.name = name;
    this.touch(false);
  }

  private pushVersion(rec: StrategyRecord, label: string): void {
    const number = (rec.versions[rec.versions.length - 1]?.number ?? 0) + 1;
    rec.versions.push({
      id: uid(),
      number,
      createdAt: new Date().toISOString(),
      label,
      note: '',
      inputs: clone(rec.draft),
      plan: clone(rec.plan),
    });
    rec.baseVersion = number;
    this.current.set({ ...rec });
    this.scheduleSave(0);
  }

  private scheduleSave(delay = 400): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saving.set(true);
    this.saveTimer = setTimeout(async () => {
      const rec = this.current();
      if (rec) {
        rec.updatedAt = new Date().toISOString();
        await db.put(clone(rec));
      }
      this.saving.set(false);
    }, delay);
  }
}
