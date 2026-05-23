-- Integ Phase 7 — bootstrap.
--
-- Tables:
--   public.plans               — plan catalog (free / pro / team).
--   public.subscriptions       — one row per user, current plan + Stripe linkage.
--   public.profiles            — 1:1 with auth.users, opt-ins etc.
--   public.entitlements_map    — plan_id × feature_key → value matrix.
-- Trigger:
--   on_auth_user_created       — auto-creates a profile row on signup.
-- RPC:
--   public.get_entitlements()  — resolves the calling user's plan and
--                                returns their entitlement flags. Used
--                                by the Typeward client to populate the
--                                EntitlementSource.

-- ------------- plans ----------------------------------------------------

create table if not exists public.plans (
  id text primary key,
  name text not null,
  price_cents int not null default 0,
  currency text not null default 'USD',
  -- 'month' / 'year' / null (free tier has no interval).
  billing_interval text,
  stripe_price_id text,
  created_at timestamptz not null default now()
);

alter table public.plans enable row level security;

-- The plan catalog is public — clients need it to render the upgrade
-- screen and so we don't have to ship it twice.
drop policy if exists plans_select_public on public.plans;
create policy plans_select_public on public.plans
  for select to anon, authenticated using (true);

-- ------------- subscriptions ---------------------------------------------

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id text not null references public.plans(id),
  -- 'active' / 'trialing' / 'past_due' / 'canceled' / 'incomplete'.
  status text not null,
  current_period_end timestamptz,
  stripe_subscription_id text unique,
  stripe_customer_id text,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One paid subscription per user. The webhook upserts on this.
  unique (user_id)
);

create index if not exists subscriptions_status_idx
  on public.subscriptions (status);

alter table public.subscriptions enable row level security;

-- Subscriptions are read-only from the client. Writes happen only via
-- the Stripe webhook edge function with the service-role key.
drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (auth.uid() = user_id);

-- ------------- profiles --------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (auth.uid() = id)
  with check (auth.uid() = id);

-- Signup hook: when a row lands in auth.users, mirror it into profiles
-- so the rest of the app can FK against profiles without race
-- conditions on first sign-in. SECURITY DEFINER because the trigger
-- needs to bypass RLS to insert. `on conflict do nothing` keeps this
-- idempotent across replays.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------- entitlements_map ------------------------------------------

create table if not exists public.entitlements_map (
  plan_id text not null references public.plans(id) on delete cascade,
  feature_key text not null,
  -- Stored as text so the same column carries booleans ('true' / 'false'),
  -- numeric limits ('3'), and free-form strings if we ever need them.
  -- Clients parse based on the feature_key contract.
  value text not null,
  primary key (plan_id, feature_key)
);

alter table public.entitlements_map enable row level security;

-- Public — the matrix is product positioning, not user data.
drop policy if exists entitlements_map_select_public on public.entitlements_map;
create policy entitlements_map_select_public on public.entitlements_map
  for select to anon, authenticated using (true);

-- ------------- get_entitlements() RPC ------------------------------------

-- Resolves the calling user's plan (falls back to 'free' when no active
-- subscription) and returns the matching entitlement rows. SECURITY
-- DEFINER so it can read across `subscriptions` RLS when joining.
--
-- Anonymous callers get the free-tier matrix; the client uses this for
-- the pre-sign-in upgrade preview without revealing other users' data.
create or replace function public.get_entitlements()
returns table (feature_key text, value text)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_user_id uuid;
  v_plan_id text;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    return query
      select em.feature_key, em.value
        from public.entitlements_map em
        where em.plan_id = 'free';
    return;
  end if;

  select s.plan_id
    into v_plan_id
    from public.subscriptions s
    where s.user_id = v_user_id
      and s.status in ('active', 'trialing')
    limit 1;

  if v_plan_id is null then
    v_plan_id := 'free';
  end if;

  return query
    select em.feature_key, em.value
      from public.entitlements_map em
      where em.plan_id = v_plan_id;
end;
$$;

grant execute on function public.get_entitlements() to anon, authenticated;
