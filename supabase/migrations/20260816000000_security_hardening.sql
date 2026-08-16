-- Keep future objects private by default. Every backend-accessible object must
-- receive an explicit service_role grant in the migration that creates it.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- Cover both foreign keys that begin with (stage_id, stage_start).
create index if not exists mint_price_change_notifications_stage_version_idx
  on public.mint_price_change_notifications (stage_id, stage_start, price_version);
