-- Row Level Security smoke test. Run with:
--   npx supabase db query --linked -f supabase/tests/rls_check.sql
-- Everything runs in one DO block that ends by raising an exception with the results,
-- so all test data (users, team, strategy) is rolled back and nothing is kept.
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-000000000001'; -- owner
  b uuid := 'bbbbbbbb-0000-4000-8000-000000000002'; -- driver, then editor
  c uuid := 'cccccccc-0000-4000-8000-000000000003'; -- outsider
  t uuid;
  s uuid;
  code text;
  n int;
  out text := '';
  failed int := 0;

begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values
    (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-owner@test.invalid', '{"full_name":"Owner"}', now(), now()),
    (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-driver@test.invalid', '{"full_name":"Driver"}', now(), now()),
    (c, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-outsider@test.invalid', '{}', now(), now());

  -- ---- owner creates a team and a strategy
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.teams (name) values ('RLS test') returning id, invite_code into t, code;
  select count(*) into n from public.team_members where team_id = t and user_id = a and role = 'owner';
  out := out || format(E'\n%s owner membership created', case when n = 1 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 1)::int;
  insert into public.strategies (team_id, name, draft) values (t, 'S', '{}') returning id into s;
  insert into public.driver_availability (strategy_id, driver_id) values (s, 'd1'), (s, 'd2');
  insert into public.strategy_versions (strategy_id, number, inputs) values (s, 1, '{}');
  out := out || E'\nPASS owner inserts strategy, availability rows, version';

  -- ---- outsider sees nothing
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.strategies where id = s;
  out := out || format(E'\n%s outsider cannot read strategy', case when n = 0 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 0)::int;
  select count(*) into n from public.teams where id = t;
  out := out || format(E'\n%s outsider cannot read team', case when n = 0 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 0)::int;
  begin
    perform public.claim_driver(s, 'd1');
    out := out || E'\nFAIL outsider claimed a driver';
    failed := failed + 1;
  exception when others then
    out := out || E'\nPASS outsider cannot claim a driver';
  end;

  -- ---- driver joins with the invite code
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.join_team(code);
  select count(*) into n from public.strategies where id = s;
  out := out || format(E'\n%s driver reads strategy after joining', case when n = 1 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 1)::int;
  update public.strategies set name = 'hacked' where id = s;
  get diagnostics n = row_count;
  out := out || format(E'\n%s driver cannot edit strategy', case when n = 0 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 0)::int;
  begin
    insert into public.strategy_versions (strategy_id, number, inputs) values (s, 2, '{}');
    out := out || E'\nFAIL driver inserted a version';
    failed := failed + 1;
  exception when others then
    out := out || E'\nPASS driver cannot save versions';
  end;
  perform public.claim_driver(s, 'd1');
  update public.driver_availability set windows = '[{"from":0,"to":1,"status":"unavailable"}]' where strategy_id = s and driver_id = 'd1';
  get diagnostics n = row_count;
  out := out || format(E'\n%s driver edits own availability', case when n = 1 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 1)::int;
  update public.driver_availability set windows = '[]' where strategy_id = s and driver_id = 'd2';
  get diagnostics n = row_count;
  out := out || format(E'\n%s driver cannot edit another driver''s availability', case when n = 0 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 0)::int;
  begin
    update public.driver_availability set user_id = b where strategy_id = s and driver_id = 'd2';
    get diagnostics n = row_count;
    out := out || format(E'\n%s driver cannot take another slot', case when n = 0 then 'PASS' else 'FAIL' end);
    failed := failed + (n <> 0)::int;
  exception when others then
    out := out || E'\nPASS driver cannot take another slot';
  end;
  update public.team_members set role = 'owner' where team_id = t and user_id = b;
  get diagnostics n = row_count;
  out := out || format(E'\n%s driver cannot promote themselves', case when n = 0 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 0)::int;
  select count(*) into n from public.profiles where id = a;
  out := out || format(E'\n%s driver sees teammate profile', case when n = 1 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 1)::int;

  -- ---- owner promotes the driver to editor
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  update public.team_members set role = 'editor' where team_id = t and user_id = b;

  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  update public.strategies set name = 'S2' where id = s;
  get diagnostics n = row_count;
  out := out || format(E'\n%s editor edits strategy', case when n = 1 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 1)::int;
  delete from public.team_members where team_id = t and user_id = a;
  get diagnostics n = row_count;
  out := out || format(E'\n%s editor cannot remove the owner', case when n = 0 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 0)::int;

  -- ---- outsider still cannot see profiles
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.profiles where id = a;
  out := out || format(E'\n%s outsider cannot see profiles', case when n = 0 then 'PASS' else 'FAIL' end);
  failed := failed + (n <> 0)::int;

  execute 'reset role';
  raise exception 'RLS CHECK (rolled back) - % failed%', failed, out;
end $$;
