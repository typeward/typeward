-- Integ Phase 6 → 7 bridge: shared templates table.
--
-- The Typeward client already supports custom-local templates under
-- `<app_data>/templates/custom/`. The matching cloud-shared path
-- (publish to a team / read templates published by others) lands when
-- the entitlement gates real users in Phase 7. The table + RLS land
-- here so migrations are append-only and the RPC catalog stays stable.

create table if not exists public.shared_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  -- Full manifest doc as in <project>/.typeward/templates/<id>/template.json.
  manifest jsonb not null,
  -- URL to the file tarball in Supabase Storage. Storage is the ONE
  -- place we use Supabase Storage — templates are shared assets, not
  -- user document storage, so this doesn't violate "files stay local".
  files_blob_url text,
  visibility text not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shared_templates_owner_idx
  on public.shared_templates (owner_id);

create table if not exists public.shared_template_grants (
  template_id uuid not null references public.shared_templates(id) on delete cascade,
  -- For Phase 7 we only support per-user grants; team grants come later.
  grantee_user_id uuid not null references auth.users(id) on delete cascade,
  can_edit boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (template_id, grantee_user_id)
);

alter table public.shared_templates enable row level security;
alter table public.shared_template_grants enable row level security;

-- Owner-or-grantee read access; owner-only writes.
drop policy if exists shared_templates_select on public.shared_templates;
create policy shared_templates_select on public.shared_templates
  for select to authenticated using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.shared_template_grants g
      where g.template_id = id and g.grantee_user_id = auth.uid()
    )
  );

drop policy if exists shared_templates_insert on public.shared_templates;
create policy shared_templates_insert on public.shared_templates
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists shared_templates_update on public.shared_templates;
create policy shared_templates_update on public.shared_templates
  for update to authenticated using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists shared_templates_delete on public.shared_templates;
create policy shared_templates_delete on public.shared_templates
  for delete to authenticated using (owner_id = auth.uid());

drop policy if exists shared_template_grants_select on public.shared_template_grants;
create policy shared_template_grants_select on public.shared_template_grants
  for select to authenticated using (
    grantee_user_id = auth.uid()
    or exists (
      select 1 from public.shared_templates t
      where t.id = template_id and t.owner_id = auth.uid()
    )
  );

drop policy if exists shared_template_grants_modify on public.shared_template_grants;
create policy shared_template_grants_modify on public.shared_template_grants
  for all to authenticated using (
    exists (
      select 1 from public.shared_templates t
      where t.id = template_id and t.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.shared_templates t
      where t.id = template_id and t.owner_id = auth.uid()
    )
  );
