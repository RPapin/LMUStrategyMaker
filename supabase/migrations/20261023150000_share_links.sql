-- Switch from teams + login to share links: whoever has a strategy's link can read and edit it.
-- Tables are closed to the public API; everything goes through security definer functions that
-- require the strategy's secret token, so strategies cannot be listed or guessed.

-- ---------------------------------------------------------------- drop the team model

drop trigger if exists on_auth_user_created on auth.users;
drop table if exists public.driver_availability cascade;
drop table if exists public.strategy_versions cascade;
drop table if exists public.strategies cascade;
drop table if exists public.team_members cascade;
drop table if exists public.teams cascade;
drop table if exists public.profiles cascade;
drop function if exists public.join_team(text);
drop function if exists public.claim_driver(uuid, text);
drop function if exists public.regenerate_invite(uuid);
drop function if exists public.handle_new_user();
drop function if exists public.handle_new_team();
drop function if exists public.team_role_of(uuid);
drop function if exists public.is_member(uuid);
drop function if exists public.can_edit(uuid);
drop function if exists public.strategy_team(uuid);
drop function if exists public.shares_team(uuid);
drop function if exists public.touch_updated_at();
drop type if exists public.team_role;

-- ---------------------------------------------------------------- tables

create table public.strategies (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  name text not null,
  draft jsonb not null,
  plan jsonb,
  base_version int,
  dirty boolean not null default true,
  -- incremented on every save, used to detect two people saving at the same time
  revision int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.strategy_versions (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategies on delete cascade,
  number int not null,
  label text not null default '',
  note text not null default '',
  inputs jsonb not null,
  plan jsonb,
  created_at timestamptz not null default now(),
  unique (strategy_id, number)
);

-- Availability per driver slot, separate from the draft so drivers and the strategist don't overwrite each other.
create table public.driver_availability (
  strategy_id uuid not null references public.strategies on delete cascade,
  driver_id text not null,
  windows jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (strategy_id, driver_id)
);

-- RLS on, no policies: no direct access from the public API.
alter table public.strategies enable row level security;
alter table public.strategy_versions enable row level security;
alter table public.driver_availability enable row level security;
revoke all on public.strategies, public.strategy_versions, public.driver_availability from anon, authenticated;

-- ---------------------------------------------------------------- functions

create function public.strategy_id_for(t text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  sid uuid;
begin
  select id into sid from public.strategies where token = t;
  if sid is null then raise exception 'Strategy not found' using errcode = 'P0002'; end if;
  return sid;
end $$;

create function public.create_strategy(p_name text, p_draft jsonb, p_plan jsonb, p_base_version int, p_dirty boolean)
returns text
language sql security definer set search_path = public as $$
  insert into public.strategies (name, draft, plan, base_version, dirty)
  values (coalesce(nullif(trim(p_name), ''), 'New strategy'), p_draft, p_plan, p_base_version, coalesce(p_dirty, true))
  returning token
$$;

create function public.get_strategy(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'token', s.token,
    'name', s.name,
    'draft', s.draft,
    'plan', s.plan,
    'base_version', s.base_version,
    'dirty', s.dirty,
    'revision', s.revision,
    'created_at', s.created_at,
    'updated_at', s.updated_at,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'number', v.number, 'label', v.label, 'note', v.note,
        'inputs', v.inputs, 'plan', v.plan, 'created_at', v.created_at
      ) order by v.number)
      from public.strategy_versions v where v.strategy_id = s.id
    ), '[]'::jsonb),
    'availability', coalesce((
      select jsonb_agg(jsonb_build_object('driver_id', a.driver_id, 'windows', a.windows))
      from public.driver_availability a where a.strategy_id = s.id
    ), '[]'::jsonb)
  )
  from public.strategies s where s.token = p_token
$$;

-- Saves the draft only if nobody saved in between; returns the new revision, raises CONFLICT otherwise.
create function public.save_strategy(
  p_token text, p_name text, p_draft jsonb, p_plan jsonb, p_base_version int, p_dirty boolean, p_revision int
) returns int
language plpgsql security definer set search_path = public as $$
declare
  rev int;
begin
  update public.strategies
     set name = p_name, draft = p_draft, plan = p_plan, base_version = p_base_version, dirty = p_dirty,
         revision = revision + 1, updated_at = now()
   where token = p_token and revision = p_revision
   returning revision into rev;
  if rev is null then
    perform public.strategy_id_for(p_token); -- raises if the token is unknown
    raise exception 'CONFLICT' using errcode = 'P0001';
  end if;
  return rev;
end $$;

-- The version number is assigned here so two people saving a version never collide.
create function public.add_version(p_token text, p_label text, p_note text, p_inputs jsonb, p_plan jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sid uuid := public.strategy_id_for(p_token);
  v public.strategy_versions;
begin
  perform 1 from public.strategies where id = sid for update;
  insert into public.strategy_versions (strategy_id, number, label, note, inputs, plan)
  values (
    sid,
    coalesce((select max(number) from public.strategy_versions where strategy_id = sid), 0) + 1,
    coalesce(p_label, ''), coalesce(p_note, ''), p_inputs, p_plan
  )
  returning * into v;
  return jsonb_build_object('id', v.id, 'number', v.number, 'created_at', v.created_at);
end $$;

create function public.update_version(p_token text, p_version uuid, p_label text, p_note text) returns void
language sql security definer set search_path = public as $$
  update public.strategy_versions set label = p_label, note = p_note
   where id = p_version and strategy_id = public.strategy_id_for(p_token)
$$;

create function public.set_availability(p_token text, p_driver text, p_windows jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.driver_availability (strategy_id, driver_id, windows)
  values (public.strategy_id_for(p_token), p_driver, coalesce(p_windows, '[]'::jsonb))
  on conflict (strategy_id, driver_id) do update set windows = excluded.windows, updated_at = now()
$$;

revoke all on function
  public.strategy_id_for(text),
  public.create_strategy(text, jsonb, jsonb, int, boolean),
  public.get_strategy(text),
  public.save_strategy(text, text, jsonb, jsonb, int, boolean, int),
  public.add_version(text, text, text, jsonb, jsonb),
  public.update_version(text, uuid, text, text),
  public.set_availability(text, text, jsonb)
from public;

grant execute on function
  public.create_strategy(text, jsonb, jsonb, int, boolean),
  public.get_strategy(text),
  public.save_strategy(text, text, jsonb, jsonb, int, boolean, int),
  public.add_version(text, text, text, jsonb, jsonb),
  public.update_version(text, uuid, text, text),
  public.set_availability(text, text, jsonb)
to anon, authenticated;
