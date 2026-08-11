alter table public.users
  add column free_mint_alerts_enabled boolean not null default false;

create table public.free_mint_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  drop_slug text not null check (drop_slug ~ '^[a-z0-9][a-z0-9-]{0,199}$'),
  stage_id text not null check (char_length(stage_id) between 1 and 200),
  stage_start timestamptz not null,
  claimed_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (user_id, stage_id, stage_start)
);

create index free_mint_notifications_user_time_idx
  on public.free_mint_notifications (user_id, stage_start desc);

alter table public.free_mint_notifications enable row level security;

revoke all on table public.free_mint_notifications from anon, authenticated;
grant all on table public.free_mint_notifications to service_role;
