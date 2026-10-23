import { Injectable, inject } from '@angular/core';
import { RealtimeChannel } from '@supabase/supabase-js';
import { AvailabilityWindow, PlanResult, StrategyInputs, StrategyRecord, StrategyVersion, TeamRole } from '../models';
import { Supabase } from './supabase';

export interface TeamSummary {
  id: string;
  name: string;
  invite_code: string;
  role: TeamRole;
}

export interface Member {
  user_id: string;
  role: TeamRole;
  display_name: string;
}

export interface StrategySummary {
  id: string;
  name: string;
  updated_at: string;
  versions: number;
}

export interface StrategyRow {
  id: string;
  team_id: string;
  name: string;
  draft: StrategyInputs;
  plan: PlanResult | null;
  base_version: number | null;
  dirty: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface VersionRow {
  id: string;
  strategy_id: string;
  number: number;
  label: string;
  note: string;
  inputs: StrategyInputs;
  plan: PlanResult | null;
  created_at: string;
}

export interface AvailabilityRow {
  strategy_id: string;
  driver_id: string;
  user_id: string | null;
  windows: AvailabilityWindow[];
}

export interface CloudStrategy {
  record: StrategyRecord;
  role: TeamRole;
  availability: AvailabilityRow[];
}

export interface RealtimeHandlers {
  strategy: (row: StrategyRow) => void;
  version: (row: VersionRow) => void;
  availability: (row: AvailabilityRow) => void;
}

/** Throws on error. Data is only read for queries that select rows, where it is never null. */
function check<T>(res: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (res.error) throw new Error(res.error.message);
  return res.data as NonNullable<T>;
}

export function versionFromRow(v: VersionRow): StrategyVersion {
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

@Injectable({ providedIn: 'root' })
export class CloudRepo {
  private readonly sb = inject(Supabase);

  private get db() {
    return this.sb.db();
  }

  private uid(): string {
    const id = this.sb.user()?.id;
    if (!id) throw new Error('Not signed in.');
    return id;
  }

  // ------------------------------------------------------------- teams

  async myTeams(): Promise<TeamSummary[]> {
    const rows = check(
      await this.db.from('team_members').select('role, teams(id, name, invite_code)').eq('user_id', this.uid()),
    ) as unknown as { role: TeamRole; teams: Omit<TeamSummary, 'role'> }[];
    return rows.filter((r) => r.teams).map((r) => ({ ...r.teams, role: r.role }));
  }

  async team(teamId: string): Promise<TeamSummary> {
    const team = check(await this.db.from('teams').select('id, name, invite_code').eq('id', teamId).single()) as Omit<
      TeamSummary,
      'role'
    >;
    const me = check(
      await this.db.from('team_members').select('role').eq('team_id', teamId).eq('user_id', this.uid()).single(),
    );
    return { ...team, role: me.role as TeamRole };
  }

  async createTeam(name: string): Promise<string> {
    const row = check(await this.db.from('teams').insert({ name }).select('id').single());
    return row.id as string;
  }

  async renameTeam(teamId: string, name: string): Promise<void> {
    check(await this.db.from('teams').update({ name }).eq('id', teamId));
  }

  async deleteTeam(teamId: string): Promise<void> {
    check(await this.db.from('teams').delete().eq('id', teamId));
  }

  async joinTeam(code: string): Promise<string> {
    return check(await this.db.rpc('join_team', { code })) as string;
  }

  async regenerateInvite(teamId: string): Promise<string> {
    return check(await this.db.rpc('regenerate_invite', { t: teamId })) as string;
  }

  async members(teamId: string): Promise<Member[]> {
    const rows = check(await this.db.from('team_members').select('user_id, role').eq('team_id', teamId)) as {
      user_id: string;
      role: TeamRole;
    }[];
    const ids = rows.map((r) => r.user_id);
    const profiles = ids.length
      ? (check(await this.db.from('profiles').select('id, display_name').in('id', ids)) as {
          id: string;
          display_name: string;
        }[])
      : [];
    const names = new Map(profiles.map((p) => [p.id, p.display_name]));
    return rows
      .map((r) => ({ ...r, display_name: names.get(r.user_id) || 'Unknown' }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  async setRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
    check(await this.db.from('team_members').update({ role }).eq('team_id', teamId).eq('user_id', userId));
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    check(await this.db.from('team_members').delete().eq('team_id', teamId).eq('user_id', userId));
  }

  // ------------------------------------------------------------- strategies

  async listStrategies(teamId: string): Promise<StrategySummary[]> {
    const rows = check(
      await this.db
        .from('strategies')
        .select('id, name, updated_at, strategy_versions(count)')
        .eq('team_id', teamId)
        .order('updated_at', { ascending: false }),
    ) as unknown as { id: string; name: string; updated_at: string; strategy_versions: { count: number }[] }[];
    return rows.map((r) => ({ id: r.id, name: r.name, updated_at: r.updated_at, versions: r.strategy_versions[0]?.count ?? 0 }));
  }

  async load(id: string): Promise<CloudStrategy> {
    const row = check(await this.db.from('strategies').select('*').eq('id', id).single()) as StrategyRow;
    const versions = check(
      await this.db.from('strategy_versions').select('*').eq('strategy_id', id).order('number'),
    ) as VersionRow[];
    const availability = check(
      await this.db.from('driver_availability').select('strategy_id, driver_id, user_id, windows').eq('strategy_id', id),
    ) as AvailabilityRow[];
    const { role } = await this.team(row.team_id);
    const record: StrategyRecord = {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      draft: row.draft,
      plan: row.plan,
      baseVersion: row.base_version,
      dirty: row.dirty,
      versions: versions.map(versionFromRow),
      teamId: row.team_id,
    };
    overlayAvailability(record.draft, availability);
    return { record, role, availability };
  }

  /** Creates a team strategy from a record (new, or uploaded from this browser). */
  async create(teamId: string, rec: StrategyRecord): Promise<string> {
    const row = check(
      await this.db
        .from('strategies')
        .insert({
          team_id: teamId,
          name: rec.name,
          draft: rec.draft,
          plan: rec.plan,
          base_version: rec.baseVersion,
          dirty: rec.dirty,
        })
        .select('id')
        .single(),
    );
    const id = row.id as string;
    if (rec.versions.length) {
      check(
        await this.db.from('strategy_versions').insert(
          rec.versions.map((v) => ({
            strategy_id: id,
            number: v.number,
            label: v.label,
            note: v.note,
            inputs: v.inputs,
            plan: v.plan,
            created_at: v.createdAt,
          })),
        ),
      );
    }
    const avail = rec.draft.drivers.filter((d) => d.availability.length);
    if (avail.length) {
      check(
        await this.db
          .from('driver_availability')
          .insert(avail.map((d) => ({ strategy_id: id, driver_id: d.id, windows: d.availability }))),
      );
    }
    return id;
  }

  async save(rec: StrategyRecord): Promise<void> {
    check(
      await this.db
        .from('strategies')
        .update({
          name: rec.name,
          draft: rec.draft,
          plan: rec.plan,
          base_version: rec.baseVersion,
          dirty: rec.dirty,
          updated_by: this.uid(),
        })
        .eq('id', rec.id),
    );
  }

  async remove(id: string): Promise<void> {
    check(await this.db.from('strategies').delete().eq('id', id));
  }

  async addVersion(strategyId: string, v: StrategyVersion): Promise<void> {
    check(
      await this.db.from('strategy_versions').insert({
        id: v.id,
        strategy_id: strategyId,
        number: v.number,
        label: v.label,
        note: v.note,
        inputs: v.inputs,
        plan: v.plan,
        created_at: v.createdAt,
      }),
    );
  }

  async updateVersionMeta(v: StrategyVersion): Promise<void> {
    check(await this.db.from('strategy_versions').update({ label: v.label, note: v.note }).eq('id', v.id));
  }

  // ------------------------------------------------------------- availability

  /** Drivers can only update their own (claimed) row; editors can create rows for any slot. */
  async saveAvailability(strategyId: string, driverId: string, windows: AvailabilityWindow[], canEdit: boolean): Promise<void> {
    const updated = check(
      await this.db
        .from('driver_availability')
        .update({ windows })
        .eq('strategy_id', strategyId)
        .eq('driver_id', driverId)
        .select('driver_id'),
    );
    if (updated.length || !canEdit) return;
    check(await this.db.from('driver_availability').insert({ strategy_id: strategyId, driver_id: driverId, windows }));
  }

  async claimDriver(strategyId: string, driverId: string): Promise<void> {
    check(await this.db.rpc('claim_driver', { strategy: strategyId, driver: driverId }));
  }

  /** Editor links a driver slot to a team member (or unlinks it with null). */
  async linkDriver(strategyId: string, driverId: string, userId: string | null): Promise<void> {
    if (userId) {
      check(
        await this.db
          .from('driver_availability')
          .update({ user_id: null })
          .eq('strategy_id', strategyId)
          .eq('user_id', userId)
          .neq('driver_id', driverId),
      );
    }
    check(
      await this.db
        .from('driver_availability')
        .upsert({ strategy_id: strategyId, driver_id: driverId, user_id: userId }, { onConflict: 'strategy_id,driver_id' }),
    );
  }

  // ------------------------------------------------------------- realtime

  subscribe(strategyId: string, h: RealtimeHandlers): () => void {
    const channel: RealtimeChannel = this.db
      .channel(`strategy:${strategyId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'strategies', filter: `id=eq.${strategyId}` }, (p) =>
        h.strategy(p.new as StrategyRow),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'strategy_versions', filter: `strategy_id=eq.${strategyId}` },
        (p) => h.version(p.new as VersionRow),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'driver_availability', filter: `strategy_id=eq.${strategyId}` },
        (p) => p.new && 'driver_id' in p.new && h.availability(p.new as AvailabilityRow),
      )
      .subscribe();
    return () => {
      this.db.removeChannel(channel);
    };
  }
}
