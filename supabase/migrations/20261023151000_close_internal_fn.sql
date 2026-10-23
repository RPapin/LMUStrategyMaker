-- Supabase grants execute on new functions to anon/authenticated by default: close the internal helper.
revoke execute on function public.strategy_id_for(text) from anon, authenticated;
