# Typeward Infrastructure (Supabase)

Temporary home for Typeward's Supabase backend. Migrations, RPCs, RLS
policies, and Stripe webhook edge functions live here during Integ
Phase 7. **Once the phase lands, this folder gets `git mv`'d into the
dedicated `infrastructure` GitHub repo** — keeping it in the Typeward
repo right now just makes the round-trips quick.

## What's here

```
infrastructure/
  README.md
  supabase/
    config.toml                              # supabase CLI project config
    migrations/
      20260523000001_init.sql                # plans + subscriptions + profiles +
                                             # entitlements_map + RLS + signup trigger +
                                             # get_entitlements() RPC
      20260523000002_shared_templates.sql    # shared templates + grants (Phase 7+)
    seed.sql                                 # free/pro/team plans + entitlement matrix
```

## One-time setup

Install the Supabase CLI: <https://supabase.com/docs/guides/cli/getting-started>

```sh
cd infrastructure
supabase link --project-ref aepfxzsnhjonzevwglgr   # typeward-staging
```

You'll be prompted for the database password (find it in the Supabase
dashboard → Project Settings → Database). The token's stored locally
under `~/.supabase/`, scoped to your account.

## Apply migrations to staging

```sh
cd infrastructure
supabase db push
```

This runs every pending migration in `supabase/migrations/` against the
linked project. The CLI prints a diff first so you can review.

To re-seed (idempotent — uses `on conflict do nothing`):

```sh
supabase db reset --linked     # NUKES staging data — only when iterating early
# or, less destructive:
psql "$(supabase db url)" -f supabase/seed.sql
psql "$(supabase db url)" -f supabase/seed_test_users.sql   # staging only
```

`seed_test_users.sql` upserts test@test.cz to a Pro subscription so
entitlement gating exercises end-to-end without Stripe. It's
intentionally separate from `seed.sql` so the plan-catalog seed can
ship to production while test-account seeding stays staging-only.

## Regenerate the client types

After every migration:

```sh
supabase gen types typescript --linked > ../src/integrations/supabase/database.types.ts
```

The generated file is committed in the Typeward repo so the frontend
gets strongly-typed RPC + table queries without an extra build step.

## Stripe webhook (when billing wires up)

`supabase/edge-functions/stripe-webhook/` will hold the webhook handler
that upserts `subscriptions` on `customer.subscription.*` events. Deploy
with `supabase functions deploy stripe-webhook`. Stripe's
`STRIPE_WEBHOOK_SIGNING_SECRET` lives in the Supabase project secrets,
not in this repo.

## Move-out checklist (end of Phase 7)

1. `git mv infrastructure/ ../<wherever the dedicated repo lives>/`
2. Update the Typeward `CLAUDE.md` to drop the in-repo path reference.
3. Add `infrastructure/` to the Typeward `.gitignore` so a stale local
   copy can't accidentally land back on `main`.
4. Keep `database.types.ts` committed in the Typeward repo so client
   builds don't depend on the infrastructure repo being checked out.
