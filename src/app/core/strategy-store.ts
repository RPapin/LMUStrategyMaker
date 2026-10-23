import { Injectable, computed, inject, signal } from '@angular/core';
import { AvailabilityRow, CloudRepo, ConflictError, LiveChannel, overlayAvailability } from './cloud/cloud-repo';
import { Supabase } from './cloud/supabase';
import { db } from './db';
import { defaultInputs, tyresForCategory } from './defaults';
import { assignCrew } from './engine/assign';
import { computeStrategy, retime } from './engine/strategy';
import { Driver, StrategyInputs, StrategyRecord, StrategyVersion } from './models';
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

export interface SharedEntry {
  token: string;
  name: string;
  openedAt: string;
}

const SHARED_KEY = 'sm-shared';
const meKey = (token: string) => `sm-me-${token}`;

function readStorage<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode): only the convenience is lost
  }
}

@Injectable({ providedIn: 'root' })
export class StrategyStore {
  private readonly sb = inject(Supabase);
  private readonly cloud = inject(CloudRepo);

  readonly list = signal<StrategyRecord[]>([]);
  /** Shared strategies opened in this browser. */
  readonly shared = signal<SharedEntry[]>(readStorage<SharedEntry[]>(SHARED_KEY, []));
  readonly current = signal<StrategyRecord | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly saving = signal(false);
  readonly sharingAvailable = this.sb.configured;

  readonly isShared = computed(() => !!this.current()?.shareToken);
  /** Which driver of the shared strategy this browser is (remembered per strategy). */
  readonly myDriverId = signal<string | null>(null);

  private revision = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly availabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly versionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private channel: LiveChannel | null = null;

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
    rec.shareToken = null;
    rec.updatedAt = new Date().toISOString();
    await db.put(rec);
    await this.refreshList();
    return rec;
  }

  export(rec: StrategyRecord): string {
    const { shareToken: _token, ...rest } = rec;
    return JSON.stringify(rest, null, 2);
  }

  // ------------------------------------------------------------- sharing

  /** Creates a new shared strategy. Returns its link token. */
  async createShared(name: string): Promise<string> {
    return this.cloud.create(this.newRecord(name));
  }

  /** Copies a local strategy (with its versions) to a share link. The local copy is kept. */
  async share(localId: string): Promise<string> {
    const rec = await db.get(localId);
    if (!rec) throw new Error('Strategy not found.');
    migrate(rec);
    return this.cloud.create(rec);
  }

  shareUrl(token: string): string {
    return `${location.origin}/s/${token}`;
  }

  forgetShared(token: string): void {
    this.shared.set(this.shared().filter((s) => s.token !== token));
    writeStorage(SHARED_KEY, this.shared());
  }

  private rememberShared(rec: StrategyRecord): void {
    const entry: SharedEntry = { token: rec.shareToken!, name: rec.name, openedAt: new Date().toISOString() };
    this.shared.set([entry, ...this.shared().filter((s) => s.token !== entry.token)].slice(0, 50));
    writeStorage(SHARED_KEY, this.shared());
  }

  setMe(driverId: string | null): void {
    const token = this.current()?.shareToken;
    if (!token) return;
    this.myDriverId.set(driverId);
    writeStorage(meKey(token), driverId);
  }

  // ------------------------------------------------------------- open / close

  /** Opens a local strategy (by id) or a shared one (by link token). */
  async load(id: string, shared = false): Promise<boolean> {
    this.close();
    this.error.set(null);
    this.notice.set(null);
    if (!shared) {
      const rec = await db.get(id);
      if (rec) migrate(rec);
      this.current.set(rec ?? null);
      return !!rec;
    }
    try {
      const res = await this.cloud.load(id);
      if (!res) return false;
      migrate(res.record);
      this.revision = res.revision;
      this.current.set(res.record);
      this.myDriverId.set(readStorage<string | null>(meKey(id), null));
      this.rememberShared(res.record);
      this.channel = this.cloud.live(id, {
        strategy: (revision) => this.onRemoteSave(revision),
        version: () => this.onRemoteVersion(),
        availability: (row) => this.onRemoteAvailability(row),
      });
      return true;
    } catch (e) {
      this.error.set(errorText(e));
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
    this.channel?.close();
    this.channel = null;
    this.myDriverId.set(null);
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
   * A driver's availability changed. For a shared strategy it is also saved in its own row,
   * so a driver setting theirs does not overwrite what the strategist edits at the same time.
   */
  availabilityChanged(driver: Driver): void {
    const rec = this.current();
    if (!rec) return;
    const token = rec.shareToken;
    if (!token) {
      this.touch(false);
      return;
    }
    // only the availability row is saved, not the whole strategy
    this.current.set({ ...rec });
    clearTimeout(this.availabilityTimers.get(driver.id));
    this.availabilityTimers.set(
      driver.id,
      setTimeout(async () => {
        this.availabilityTimers.delete(driver.id);
        try {
          await this.cloud.setAvailability(token, driver.id, driver.availability);
          this.channel?.availabilityChanged({ driver_id: driver.id, windows: driver.availability });
        } catch (e) {
          this.error.set(`Availability not saved: ${errorText(e)}`);
        }
      }, 400),
    );
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
      this.error.set(errorText(e));
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

  /**
   * Restoring never deletes anything: the old version is copied as a new one.
   * Availability is not rolled back: it belongs to the drivers, not to a version.
   */
  restore(version: StrategyVersion): void {
    const rec = this.current();
    if (!rec) return;
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
    const token = this.current()?.shareToken;
    if (!token) {
      this.touch(false);
      return;
    }
    clearTimeout(this.versionTimers.get(version.id));
    this.versionTimers.set(
      version.id,
      setTimeout(() => {
        this.versionTimers.delete(version.id);
        this.cloud.updateVersion(token, version).catch((e) => this.error.set(errorText(e)));
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
    const version: StrategyVersion = {
      id: uid(),
      number: (rec.versions[rec.versions.length - 1]?.number ?? 0) + 1,
      createdAt: new Date().toISOString(),
      label,
      note: '',
      inputs: clone(rec.draft),
      plan: clone(rec.plan),
    };
    rec.versions.push(version);
    rec.baseVersion = version.number;
    this.current.set({ ...rec });
    const token = rec.shareToken;
    if (!token) {
      this.scheduleSave(0);
      return;
    }
    // the server numbers versions, so two people saving at once never collide
    this.saving.set(true);
    this.cloud
      .addVersion(token, version)
      .then((saved) => {
        Object.assign(version, saved);
        rec.versions.sort((a, b) => a.number - b.number);
        rec.baseVersion = saved.number;
        this.current.set({ ...rec });
        this.channel?.versionAdded();
        this.scheduleSave(0);
      })
      .catch((e) => {
        this.saving.set(false);
        this.error.set(`Version not saved: ${errorText(e)}`);
      });
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
    rec.updatedAt = new Date().toISOString();
    try {
      if (!rec.shareToken) {
        await db.put(clone(rec));
      } else {
        this.revision = await this.cloud.save(rec.shareToken, rec, this.revision);
        this.channel?.strategySaved(this.revision);
        this.rememberShared(rec);
      }
    } catch (e) {
      if (e instanceof ConflictError) await this.reloadAfterConflict();
      else this.error.set(`Not saved: ${errorText(e)}`);
    }
    this.saving.set(false);
  }

  // ------------------------------------------------------------- live updates

  /** Someone else saved in between: take their version so nothing is silently overwritten. */
  private async reloadAfterConflict(): Promise<void> {
    await this.reloadFromServer();
    this.notice.set('Someone else changed this strategy at the same time. Their version is loaded: redo your last change.');
  }

  private async reloadFromServer(): Promise<void> {
    const rec = this.current();
    if (!rec?.shareToken) return;
    const res = await this.cloud.load(rec.shareToken);
    if (!res || this.current()?.shareToken !== rec.shareToken) return;
    migrate(res.record);
    this.revision = res.revision;
    this.current.set(res.record);
  }

  private onRemoteSave(revision: number): void {
    // a pending local save will detect the conflict itself
    if (revision <= this.revision || this.saveTimer) return;
    this.reloadFromServer().catch((e) => this.error.set(errorText(e)));
  }

  private async onRemoteVersion(): Promise<void> {
    const rec = this.current();
    if (!rec?.shareToken) return;
    const res = await this.cloud.load(rec.shareToken);
    if (!res || this.current() !== rec) return;
    migrate(res.record);
    const known = new Set(rec.versions.map((v) => v.id));
    rec.versions.push(...res.record.versions.filter((v) => !known.has(v.id)));
    rec.versions.sort((a, b) => a.number - b.number);
    this.current.set({ ...rec });
  }

  private onRemoteAvailability(row: AvailabilityRow): void {
    const rec = this.current();
    if (!rec || this.availabilityTimers.has(row.driver_id)) return; // our own pending edit is newer
    overlayAvailability(rec.draft, [row]);
    this.current.set({ ...rec });
  }
}
