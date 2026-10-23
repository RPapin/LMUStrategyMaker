import { Injectable, computed, inject, signal } from '@angular/core';
import { AvailabilityRow, CloudRepo, Member, overlayAvailability, StrategyRow, versionFromRow } from './cloud/cloud-repo';
import { Supabase } from './cloud/supabase';
import { db } from './db';
import { defaultInputs, tyresForCategory } from './defaults';
import { assignCrew } from './engine/assign';
import { computeStrategy, retime } from './engine/strategy';
import { Driver, StrategyInputs, StrategyRecord, StrategyVersion, TeamRole } from './models';
import { clone, uid } from './util';

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

/** Brings records saved by older app versions up to date. */
export function migrate(rec: StrategyRecord): void {
  migrateInputs(rec.draft);
  migratePlan(rec.plan);
  rec.versions.forEach((v) => {
    migrateInputs(v.inputs);
    migratePlan(v.plan);
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

@Injectable({ providedIn: 'root' })
export class StrategyStore {
  private readonly sb = inject(Supabase);
  private readonly cloud = inject(CloudRepo);

  readonly list = signal<StrategyRecord[]>([]);
  readonly current = signal<StrategyRecord | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly saving = signal(false);

  /** Role in the team of the current strategy, null for a local strategy. */
  readonly role = signal<TeamRole | null>(null);
  /** Driver slot -> linked user, for team strategies. */
  readonly links = signal<Record<string, string | null>>({});
  readonly members = signal<Member[]>([]);
  readonly isCloud = computed(() => !!this.current()?.teamId);
  readonly canEdit = computed(() => !this.current()?.teamId || this.role() === 'owner' || this.role() === 'editor');
  /** The driver slot of the signed-in user in the current team strategy. */
  readonly myDriverId = computed(() => {
    const me = this.sb.user()?.id;
    const entry = Object.entries(this.links()).find(([, u]) => u === me);
    return me && entry ? entry[0] : null;
  });

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly availabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly versionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;

  // ------------------------------------------------------------- local list

  async refreshList(): Promise<void> {
    const all = await db.all();
    this.list.set(all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  newRecord(name: string): StrategyRecord {
    const now = new Date().toISOString();
    return {
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
  }

  async create(name: string): Promise<StrategyRecord> {
    const rec = this.newRecord(name);
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

  async import(json: string): Promise<StrategyRecord> {
    const rec = JSON.parse(json) as StrategyRecord;
    if (!rec?.draft?.race || !Array.isArray(rec.versions)) throw new Error('Not a strategy file.');
    migrate(rec);
    rec.id = uid();
    rec.teamId = null;
    rec.updatedAt = new Date().toISOString();
    await db.put(rec);
    await this.refreshList();
    return rec;
  }

  export(rec: StrategyRecord): string {
    const { teamId: _team, ...rest } = rec;
    return JSON.stringify(rest, null, 2);
  }

  /** Copies a local strategy (with its versions) into a team. Returns the new team strategy id. */
  async uploadToTeam(localId: string, teamId: string): Promise<string> {
    const rec = await db.get(localId);
    if (!rec) throw new Error('Strategy not found.');
    migrate(rec);
    return this.cloud.create(teamId, rec);
  }

  // ------------------------------------------------------------- open / close

  async load(id: string, teamId?: string): Promise<boolean> {
    this.close();
    this.error.set(null);
    if (!teamId) {
      const rec = await db.get(id);
      if (rec) migrate(rec);
      this.current.set(rec ?? null);
      return !!rec;
    }
    try {
      const { record, role, availability } = await this.cloud.load(id);
      migrate(record);
      this.role.set(role);
      this.members.set(await this.cloud.members(record.teamId!));
      this.links.set(Object.fromEntries(availability.map((a) => [a.driver_id, a.user_id])));
      this.current.set(record);
      this.unsubscribe = this.cloud.subscribe(id, {
        strategy: (row) => this.onRemoteStrategy(row),
        version: (row) => this.onRemoteVersion(versionFromRow(row)),
        availability: (row) => this.onRemoteAvailability(row),
      });
      return true;
    } catch (e) {
      this.error.set(errorText(e));
      this.current.set(null);
      return false;
    }
  }

  close(): void {
    // save a pending edit before leaving
    const rec = this.current();
    if (this.saveTimer && rec) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.persist(rec);
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.role.set(null);
    this.links.set({});
    this.members.set([]);
    this.current.set(null);
  }

  // ------------------------------------------------------------- edits

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

  /**
   * A driver's availability changed. In a team it is stored in its own row so that
   * every driver can edit theirs without write access to the strategy.
   */
  availabilityChanged(driver: Driver): void {
    const rec = this.current();
    if (!rec) return;
    if (!rec.teamId) {
      this.touch(false);
      return;
    }
    this.current.set({ ...rec });
    if (this.canEdit()) this.scheduleSave();
    const key = driver.id;
    clearTimeout(this.availabilityTimers.get(key));
    this.availabilityTimers.set(
      key,
      setTimeout(async () => {
        this.availabilityTimers.delete(key);
        try {
          await this.cloud.saveAvailability(rec.id, driver.id, driver.availability, this.canEdit());
        } catch (e) {
          this.error.set(`Availability not saved: ${errorText(e)}`);
        }
      }, 400),
    );
  }

  async claimDriver(driverId: string): Promise<void> {
    const rec = this.current();
    if (!rec?.teamId) return;
    try {
      await this.cloud.claimDriver(rec.id, driverId);
      const me = this.sb.user()!.id;
      const links = { ...this.links() };
      for (const k of Object.keys(links)) if (links[k] === me) links[k] = null;
      links[driverId] = me;
      this.links.set(links);
    } catch (e) {
      this.error.set(errorText(e));
    }
  }

  async linkDriver(driverId: string, userId: string | null): Promise<void> {
    const rec = this.current();
    if (!rec?.teamId) return;
    try {
      await this.cloud.linkDriver(rec.id, driverId, userId);
      const links = { ...this.links() };
      if (userId) for (const k of Object.keys(links)) if (links[k] === userId) links[k] = null;
      links[driverId] = userId;
      this.links.set(links);
    } catch (e) {
      this.error.set(errorText(e));
    }
  }

  /** Full recalculation (stints + crew), saved as a new version. */
  calculate(label = 'Recalculated'): boolean {
    const rec = this.current();
    if (!rec || !this.canEdit()) return false;
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
      this.error.set(errorText(e));
      return false;
    }
  }

  /** Re-balance only the crew on the current stints, saved as a new version. */
  rebalanceCrew(): void {
    const rec = this.current();
    if (!rec?.plan || !this.canEdit()) return;
    rec.draft.assignments = assignCrew(rec.draft, rec.plan);
    rec.plan = retime(rec.plan, rec.draft);
    this.pushVersion(rec, 'Crew re-balanced');
  }

  saveVersion(label: string): void {
    const rec = this.current();
    if (rec && this.canEdit()) this.pushVersion(rec, label || 'Manual save');
  }

  /**
   * Restoring never deletes anything: the old version is copied as a new one.
   * Availability is not rolled back: it belongs to the drivers, not to a version.
   */
  restore(version: StrategyVersion): void {
    const rec = this.current();
    if (!rec || !this.canEdit()) return;
    const windows = new Map(rec.draft.drivers.map((d) => [d.id, d.availability]));
    rec.draft = clone(version.inputs);
    for (const d of rec.draft.drivers) d.availability = windows.get(d.id) ?? d.availability;
    rec.plan = clone(version.plan);
    rec.dirty = false;
    this.pushVersion(rec, `Restored from v${version.number}`);
  }

  updateVersionMeta(version: StrategyVersion, label: string, note: string): void {
    version.label = label;
    version.note = note;
    const rec = this.current();
    if (!rec?.teamId) {
      this.touch(false);
      return;
    }
    clearTimeout(this.versionTimers.get(version.id));
    this.versionTimers.set(
      version.id,
      setTimeout(() => {
        this.versionTimers.delete(version.id);
        this.cloud.updateVersionMeta(version).catch((e) => this.error.set(errorText(e)));
      }, 500),
    );
  }

  rename(name: string): void {
    const rec = this.current();
    if (!rec) return;
    rec.name = name;
    this.touch(false);
  }

  // ------------------------------------------------------------- persistence

  private pushVersion(rec: StrategyRecord, label: string): void {
    const number = (rec.versions[rec.versions.length - 1]?.number ?? 0) + 1;
    const version: StrategyVersion = {
      id: uid(),
      number,
      createdAt: new Date().toISOString(),
      label,
      note: '',
      inputs: clone(rec.draft),
      plan: clone(rec.plan),
    };
    rec.versions.push(version);
    rec.baseVersion = number;
    this.current.set({ ...rec });
    if (rec.teamId) {
      this.cloud
        .addVersion(rec.id, version)
        .catch((e) => this.error.set(`Version v${number} not saved (another editor may have saved at the same time, reload): ${errorText(e)}`));
    }
    this.scheduleSave(0);
  }

  private scheduleSave(delay = 400): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saving.set(true);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const rec = this.current();
      if (rec) this.persist(rec);
      else this.saving.set(false);
    }, delay);
  }

  private async persist(rec: StrategyRecord): Promise<void> {
    const canEdit = this.canEdit();
    try {
      rec.updatedAt = new Date().toISOString();
      if (!rec.teamId) await db.put(clone(rec));
      else if (canEdit) await this.cloud.save(rec);
    } catch (e) {
      this.error.set(`Not saved: ${errorText(e)}`);
    }
    this.saving.set(false);
  }

  // ------------------------------------------------------------- realtime

  private onRemoteStrategy(row: StrategyRow): void {
    const rec = this.current();
    if (!rec || row.updated_by === this.sb.user()?.id || this.saveTimer) return;
    const draft = row.draft;
    const windows = new Map(rec.draft.drivers.map((d) => [d.id, d.availability]));
    migrateInputs(draft);
    for (const d of draft.drivers) d.availability = windows.get(d.id) ?? d.availability;
    rec.draft = draft;
    rec.plan = row.plan;
    migratePlan(rec.plan);
    rec.name = row.name;
    rec.baseVersion = row.base_version;
    rec.dirty = row.dirty;
    this.current.set({ ...rec });
    this.notice.set('Updated by a teammate.');
  }

  private onRemoteVersion(v: StrategyVersion): void {
    const rec = this.current();
    if (!rec || rec.versions.some((x) => x.id === v.id || x.number === v.number)) return;
    migrateInputs(v.inputs);
    migratePlan(v.plan);
    rec.versions.push(v);
    rec.versions.sort((a, b) => a.number - b.number);
    this.current.set({ ...rec });
  }

  private onRemoteAvailability(row: AvailabilityRow): void {
    const rec = this.current();
    if (!rec) return;
    this.links.set({ ...this.links(), [row.driver_id]: row.user_id });
    if (this.availabilityTimers.has(row.driver_id)) return; // our own pending edit is newer
    overlayAvailability(rec.draft, [row]);
    this.current.set({ ...rec });
  }
}
