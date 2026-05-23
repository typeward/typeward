-- Plan catalog + entitlement matrix.
--
-- Idempotent: `on conflict do nothing` so this can be replayed against
-- a partially-seeded staging without manual cleanup.
--
-- The tier matrix mirrors the one in the approved integrations plan:
-- anything that runs entirely locally with no third-party paid API
-- stays Free; anything consuming a third-party cloud API or a team
-- collaboration surface goes Pro/Team.

-- ------------- plans ----------------------------------------------------

insert into public.plans (id, name, price_cents, currency, billing_interval) values
  ('free', 'Free', 0, 'USD', null),
  ('pro',  'Pro',  900, 'USD', 'month'),
  ('team', 'Team', 1900, 'USD', 'month')
on conflict (id) do nothing;

-- ------------- entitlements_map -----------------------------------------
-- Conventions:
--   - Booleans stored as 'true' / 'false'.
--   - Numeric limits stored as decimal strings (parsed client-side).
--   - Feature keys mirror the EntitlementKey shape in the client.

-- ----- references -----------------------------------------------
insert into public.entitlements_map (plan_id, feature_key, value) values
  -- Local providers — always available.
  ('free', 'integrations.references.zotero.local',  'true'),
  ('pro',  'integrations.references.zotero.local',  'true'),
  ('team', 'integrations.references.zotero.local',  'true'),
  ('free', 'integrations.references.jabref',        'true'),
  ('pro',  'integrations.references.jabref',        'true'),
  ('team', 'integrations.references.jabref',        'true'),
  ('free', 'integrations.references.doi_lookup',    'true'),
  ('pro',  'integrations.references.doi_lookup',    'true'),
  ('team', 'integrations.references.doi_lookup',    'true'),
  -- Cloud providers — Pro+ only.
  ('free', 'integrations.references.zotero.web',    'false'),
  ('pro',  'integrations.references.zotero.web',    'true'),
  ('team', 'integrations.references.zotero.web',    'true'),
  ('free', 'integrations.references.mendeley',      'false'),
  ('pro',  'integrations.references.mendeley',      'true'),
  ('team', 'integrations.references.mendeley',      'true')
on conflict (plan_id, feature_key) do nothing;

-- ----- cloud storage -------------------------------------------
insert into public.entitlements_map (plan_id, feature_key, value) values
  -- iCloud is OS-mediated, no API calls; free.
  ('free', 'integrations.cloud.icloud',   'true'),
  ('pro',  'integrations.cloud.icloud',   'true'),
  ('team', 'integrations.cloud.icloud',   'true'),
  -- Third-party cloud providers — Pro+.
  ('free', 'integrations.cloud.dropbox',  'false'),
  ('pro',  'integrations.cloud.dropbox',  'true'),
  ('team', 'integrations.cloud.dropbox',  'true'),
  ('free', 'integrations.cloud.onedrive', 'false'),
  ('pro',  'integrations.cloud.onedrive', 'true'),
  ('team', 'integrations.cloud.onedrive', 'true'),
  ('free', 'integrations.cloud.gdrive',   'false'),
  ('pro',  'integrations.cloud.gdrive',   'true'),
  ('team', 'integrations.cloud.gdrive',   'true')
on conflict (plan_id, feature_key) do nothing;

-- ----- VCS ------------------------------------------------------
-- All free — git's value to the user doesn't grow with our plan; GitHub
-- uses the user's own token (no Typeward-funded API calls).
insert into public.entitlements_map (plan_id, feature_key, value) values
  ('free', 'integrations.vcs.git',              'true'),
  ('pro',  'integrations.vcs.git',              'true'),
  ('team', 'integrations.vcs.git',              'true'),
  ('free', 'integrations.vcs.github',           'true'),
  ('pro',  'integrations.vcs.github',           'true'),
  ('team', 'integrations.vcs.github',           'true'),
  ('free', 'integrations.vcs.overleaf_import',  'true'),
  ('pro',  'integrations.vcs.overleaf_import',  'true'),
  ('team', 'integrations.vcs.overleaf_import',  'true')
on conflict (plan_id, feature_key) do nothing;

-- ----- AI -------------------------------------------------------
-- Ollama runs locally; free. Cloud AI consumes the user's own API key
-- but we paywall to differentiate the product.
insert into public.entitlements_map (plan_id, feature_key, value) values
  ('free', 'integrations.ai.ollama',    'true'),
  ('pro',  'integrations.ai.ollama',    'true'),
  ('team', 'integrations.ai.ollama',    'true'),
  ('free', 'integrations.ai.anthropic', 'false'),
  ('pro',  'integrations.ai.anthropic', 'true'),
  ('team', 'integrations.ai.anthropic', 'true'),
  ('free', 'integrations.ai.openai',    'false'),
  ('pro',  'integrations.ai.openai',    'true'),
  ('team', 'integrations.ai.openai',    'true'),
  ('free', 'integrations.ai.gemini',    'false'),
  ('pro',  'integrations.ai.gemini',    'true'),
  ('team', 'integrations.ai.gemini',    'true')
on conflict (plan_id, feature_key) do nothing;

-- ----- grammar --------------------------------------------------
-- Harper is local-only; free everywhere.
insert into public.entitlements_map (plan_id, feature_key, value) values
  ('free', 'integrations.grammar.harper', 'true'),
  ('pro',  'integrations.grammar.harper', 'true'),
  ('team', 'integrations.grammar.harper', 'true')
on conflict (plan_id, feature_key) do nothing;

-- ----- templates ------------------------------------------------
insert into public.entitlements_map (plan_id, feature_key, value) values
  -- Built-in free templates: everyone.
  ('free', 'templates.builtin.free',    'true'),
  ('pro',  'templates.builtin.free',    'true'),
  ('team', 'templates.builtin.free',    'true'),
  -- Premium built-in templates (future Springer / ACM variants).
  ('free', 'templates.builtin.pro',     'false'),
  ('pro',  'templates.builtin.pro',     'true'),
  ('team', 'templates.builtin.pro',     'true'),
  -- Custom local — Free has a count cap, Pro+ unlimited.
  ('free', 'templates.custom.max',      '3'),
  ('pro',  'templates.custom.max',      'unlimited'),
  ('team', 'templates.custom.max',      'unlimited'),
  -- Shared (Team only).
  ('free', 'templates.shared.read',     'false'),
  ('pro',  'templates.shared.read',     'false'),
  ('team', 'templates.shared.read',     'true'),
  ('free', 'templates.shared.publish',  'false'),
  ('pro',  'templates.shared.publish',  'false'),
  ('team', 'templates.shared.publish',  'true')
on conflict (plan_id, feature_key) do nothing;
