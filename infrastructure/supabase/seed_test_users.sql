-- Staging-only: seed the shared test account to a Pro subscription so
-- entitlement gating can be exercised end-to-end without a real Stripe
-- round-trip.
--
-- Idempotent — uses an upsert on user_id. Resolves the test user by
-- email so the auth.users uuid isn't hardcoded in the file (staging may
-- get reset; the email stays the same).
--
-- DO NOT run this against production.

do $$
declare
  v_user_id uuid;
begin
  select id into v_user_id from auth.users where email = 'test@test.cz' limit 1;
  if v_user_id is null then
    raise notice 'Test user test@test.cz not found; skipping.';
    return;
  end if;

  insert into public.subscriptions (user_id, plan_id, status, current_period_end)
    values (v_user_id, 'pro', 'active', now() + interval '1 year')
    on conflict (user_id) do update
      set plan_id = excluded.plan_id,
          status = excluded.status,
          current_period_end = excluded.current_period_end,
          updated_at = now();

  raise notice 'Seeded test@test.cz (%) to Pro.', v_user_id;
end;
$$;
