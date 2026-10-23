-- LMU Strategy Maker: teams, strategies, versions and driver availability.
-- Roles: owner / editor can edit strategies; driver can read and set their own availability.

create extension if not exists pgcrypto with schema extensions;

create type public.team_role as enum ('owner', 'editor', 'driver');

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  invite_code text not null unique default encode(extensions.gen_random_bytes(8), 'hex'),
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.team_members (
  team_id uuid not null references public.teams on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role public.team_role not null default 'driver',
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table public.strategies (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams on delete cascade,
  name text not null,
  draft jsonb not null,
  plan jsonb,
  base_version int,
  dirty boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users on delete set null
);
create index strategies_team_idx on public.strategies (team_id);

create table public.strategy_versions (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategies on delete cascade,
  number int not null,
  label text not null default '',
  note text not null default '',
  inputs jsonb not null,
  plan jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users on delete set null,
  unique (strategy_id, number)
);

-- One row per driver slot of a strategy. user_id links the slot to a team member.
create table public.driver_availability (
  strategy_id uuid not null references public.strategies on delete cascade,
  driver_id text not null,
  user_id uuid references auth.users on delete set null,
  windows jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (strategy_id, driver_id)
);
create unique index driver_availability_one_slot_per_user
  on public.driver_availability (strategy_id, user_id) where user_id is not null;

-- ---------------------------------------------------------------- helpers

create function public.team_role_of(t uuid) returns public.team_role
language sql stable security definer set search_path = public as $$
  select role from public.team_members where team_id = t and user_id = auth.uid()
$$;

create function public.is_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members where team_id = t and user_id = auth.uid())
$$;

create function public.can_edit(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.team_role_of(t) in ('owner', 'editor'), false)
$$;

create function public.strategy_team(s uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select team_id from public.strategies where id = s
$$;

create function public.shares_team(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members a
    join public.team_members b on a.team_id = b.team_id
    where a.user_id = auth.uid() and b.user_id = other
  )
$$;

create function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger strategies_updated_at before update on public.strategies
  for each row execute function public.touch_updated_at();
create trigger driver_availability_updated_at before update on public.driver_availability
  for each row execute function public.touch_updated_at();

-- profile for every new user
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1),
      'Driver'
    )
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- the creator of a team becomes its owner
create function public.handle_new_team() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.team_members (team_id, user_id, role) values (new.id, new.created_by, 'owner');
  return new;
end $$;

create trigger on_team_created after insert on public.teams
  for each row execute function public.handle_new_team();

-- ---------------------------------------------------------------- RPCs

create function public.join_team(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id into t from public.teams where invite_code = code;
  if t is null then raise exception 'Invalid invite link'; end if;
  insert into public.team_members (team_id, user_id, role) values (t, auth.uid(), 'driver')
    on conflict do nothing;
  return t;
end $$;

-- A member links themselves to a free driver slot ("This is me").
create function public.claim_driver(strategy uuid, driver text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(public.strategy_team(strategy)) then raise exception 'Not a team member'; end if;
  if exists (
    select 1 from public.driver_availability
    where strategy_id = strategy and driver_id = driver and user_id is not null and user_id <> auth.uid()
  ) then
    raise exception 'This driver is already linked to someone else';
  end if;
  update public.driver_availability set user_id = null
    where strategy_id = strategy and user_id = auth.uid() and driver_id <> driver;
  insert into public.driver_availability (strategy_id, driver_id, user_id) values (strategy, driver, auth.uid())
    on conflict (strategy_id, driver_id) do update set user_id = auth.uid();
end $$;

create function public.regenerate_invite(t uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  code text := encode(extensions.gen_random_bytes(8), 'hex');
begin
  if public.team_role_of(t) is distinct from 'owner' then raise exception 'Only the owner can do this'; end if;
  update public.teams set invite_code = code where id = t;
  return code;
end $$;

-- ---------------------------------------------------------------- RLS

alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.strategies enable row level security;
alter table public.strategy_versions enable row level security;
alter table public.driver_availability enable row level security;

create policy "profiles: read self and teammates" on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_team(id));
create policy "profiles: update self" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "teams: members read" on public.teams for select to authenticated
  using (public.is_member(id) or created_by = auth.uid());
create policy "teams: anyone signed in creates" on public.teams for insert to authenticated
  with check (created_by = auth.uid());
create policy "teams: owner updates" on public.teams for update to authenticated
  using (public.team_role_of(id) = 'owner');
create policy "teams: owner deletes" on public.teams for delete to authenticated
  using (public.team_role_of(id) = 'owner');

create policy "members: members read" on public.team_members for select to authenticated
  using (public.is_member(team_id));
create policy "members: owner changes roles" on public.team_members for update to authenticated
  using (public.team_role_of(team_id) = 'owner') with check (public.team_role_of(team_id) = 'owner');
create policy "members: owner removes, or leave" on public.team_members for delete to authenticated
  using (public.team_role_of(team_id) = 'owner' or user_id = auth.uid());

create policy "strategies: members read" on public.strategies for select to authenticated
  using (public.is_member(team_id));
create policy "strategies: editors insert" on public.strategies for insert to authenticated
  with check (public.can_edit(team_id));
create policy "strategies: editors update" on public.strategies for update to authenticated
  using (public.can_edit(team_id)) with check (public.can_edit(team_id));
create policy "strategies: editors delete" on public.strategies for delete to authenticated
  using (public.can_edit(team_id));

create policy "versions: members read" on public.strategy_versions for select to authenticated
  using (public.is_member(public.strategy_team(strategy_id)));
create policy "versions: editors insert" on public.strategy_versions for insert to authenticated
  with check (public.can_edit(public.strategy_team(strategy_id)));
create policy "versions: editors update" on public.strategy_versions for update to authenticated
  using (public.can_edit(public.strategy_team(strategy_id)));

create policy "availability: members read" on public.driver_availability for select to authenticated
  using (public.is_member(public.strategy_team(strategy_id)));
create policy "availability: editors or own slot insert" on public.driver_availability for insert to authenticated
  with check (public.can_edit(public.strategy_team(strategy_id)) or user_id = auth.uid());
create policy "availability: editors or own slot update" on public.driver_availability for update to authenticated
  using (public.can_edit(public.strategy_team(strategy_id)) or user_id = auth.uid())
  with check (public.can_edit(public.strategy_team(strategy_id)) or user_id = auth.uid());
create policy "availability: editors delete" on public.driver_availability for delete to authenticated
  using (public.can_edit(public.strategy_team(strategy_id)));

-- ---------------------------------------------------------------- realtime

alter publication supabase_realtime add table public.strategies, public.strategy_versions, public.driver_availability;
