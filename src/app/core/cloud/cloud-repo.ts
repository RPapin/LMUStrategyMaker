import { Injectable, inject } from '@angular/core';
import { RealtimeChannel } from '@supabase/supabase-js';
import { AvailabilityWindow, PlanResult, StrategyInputs, StrategyRecord, StrategyVersion } from '../models';
import { uid } from '../util';
import { Supabase } from './supabase';

interface VersionJson {
  id: string;
  number: number;
  label: string;
  note: string;
  inputs: StrategyInputs;
  plan: PlanResult | null;
  created_at: string;
}

export interface AvailabilityRow {
  driver_id: string;
  windows: AvailabilityWindow[];
}

interface StrategyJson {
  token: string;
  name: string;
  draft: StrategyInputs;
  plan: PlanResult | null;
  base_version: number | null;
  dirty: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
  versions: VersionJson[];
  availability: AvailabilityRow[];
}

export interface SharedStrategy {
  record: StrategyRecord;
  revision: number;
}

/** Someone else saved the strategy since we loaded it. */
export class ConflictError extends Error {
  constructor() {
    super('CONFLICT');
  }
}

export interface LiveHandlers {
  strategy: (revision: number) => void;
  version: () => void;
  availability: (row: AvailabilityRow) => void;
}

export interface LiveChannel {
  strategySaved(revision: number): void;
  versionAdded(): void;
  availabilityChanged(row: AvailabilityRow): void;
  close(): void;
}

function check<T>(res: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (res.error) throw res.error.message === 'CONFLICT' ? new ConflictError() : new Error(res.error.message);
  return res.data as NonNullable<T>;
}

function versionFromJson(v: VersionJson): StrategyVersion {
  return { id: v.id, number: v.number, createdAt: v.created_at, label: v.label, note: v.note, inputs: v.inputs, plan: v.plan };
}

/** Puts the availability stored per driver slot into the drivers of the inputs. */
export function overlayAvailability(inputs: StrategyInputs, rows: AvailabilityRow[]): void {
  const byDriver = new Map(rows.map((r) => [r.driver_id, r]));
  for (const d of inputs.drivers) {
    const row = byDriver.get(d.id);
    if (row) d.availability = row.windows ?? [];
  }
}

/** Shared strategies: every call needs the secret token from the link. */
@Injectable({ providedIn: 'root' })
export class CloudRepo {
  private readonly sb = inject(Supabase);
  /** Identifies this browser tab so it ignores its own live messages. */
  private readonly clientId = uid();

  private get db() {
    return this.sb.db();
  }

  /** Shares a strategy (new, or copied from this browser with its versions). Returns the link token. */
  async create(rec: StrategyRecord): Promise<string> {
    const token = check(
      await this.db.rpc('create_strategy', {
        p_name: rec.name,
        p_draft: rec.draft,
        p_plan: rec.plan,
        p_base_version: rec.baseVersion,
        p_dirty: rec.dirty,
      }),
    ) as string;
    for (const v of rec.versions) {
      check(
        await this.db.rpc('add_version', { p_token: token, p_label: v.label, p_note: v.note, p_inputs: v.inputs, p_plan: v.plan }),
      );
    }
    for (const d of rec.draft.drivers) {
      if (d.availability.length) await this.setAvailability(token, d.id, d.availability);
    }
    return token;
  }

  async load(token: string): Promise<SharedStrategy | null> {
    const s = check(await this.db.rpc('get_strategy', { p_token: token })) as StrategyJson | null;
    if (!s) return null;
    const record: StrategyRecord = {
      id: s.token,
      shareToken: s.token,
      name: s.name,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      draft: s.draft,
      plan: s.plan,
      baseVersion: s.base_version,
      dirty: s.dirty,
      versions: s.versions.map(versionFromJson),
    };
    overlayAvailability(record.draft, s.availability);
    return { record, revision: s.revision };
  }

  /** Saves only if nobody saved since `revision`; returns the new revision or throws ConflictError. */
  async save(token: string, rec: StrategyRecord, revision: number): Promise<number> {
    return check(
      await this.db.rpc('save_strategy', {
        p_token: token,
        p_name: rec.name,
        p_draft: rec.draft,
        p_plan: rec.plan,
        p_base_version: rec.baseVersion,
        p_dirty: rec.dirty,
        p_revision: revision,
      }),
    ) as number;
  }

  /** The server assigns the version number. */
  async addVersion(token: string, v: StrategyVersion): Promise<{ id: string; number: number; createdAt: string }> {
    const r = check(
      await this.db.rpc('add_version', { p_token: token, p_label: v.label, p_note: v.note, p_inputs: v.inputs, p_plan: v.plan }),
    ) as { id: string; number: number; created_at: string };
    return { id: r.id, number: r.number, createdAt: r.created_at };
  }

  async updateVersion(token: string, v: StrategyVersion): Promise<void> {
    check(await this.db.rpc('update_version', { p_token: token, p_version: v.id, p_label: v.label, p_note: v.note }));
  }

  async setAvailability(token: string, driverId: string, windows: AvailabilityWindow[]): Promise<void> {
    check(await this.db.rpc('set_availability', { p_token: token, p_driver: driverId, p_windows: windows }));
  }

  /** Live updates between everyone who has the strategy open (broadcast channel named after the token). */
  live(token: string, h: LiveHandlers): LiveChannel {
    const channel: RealtimeChannel = this.db.channel(`strategy:${token}`, { config: { broadcast: { self: false } } });
    channel
      .on('broadcast', { event: 'strategy' }, ({ payload }) => payload.from !== this.clientId && h.strategy(payload.revision))
      .on('broadcast', { event: 'version' }, ({ payload }) => payload.from !== this.clientId && h.version())
      .on('broadcast', { event: 'availability' }, ({ payload }) => payload.from !== this.clientId && h.availability(payload.row))
      .subscribe();
    const send = (event: string, payload: Record<string, unknown>) =>
      channel.send({ type: 'broadcast', event, payload: { ...payload, from: this.clientId } });
    return {
      strategySaved: (revision) => send('strategy', { revision }),
      versionAdded: () => send('version', {}),
      availabilityChanged: (row) => send('availability', { row }),
      close: () => {
        this.db.removeChannel(channel);
      },
    };
  }
}
