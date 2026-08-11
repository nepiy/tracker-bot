create table public.mint_stage_prices (
  stage_id text not null check (char_length(stage_id) between 1 and 200),
  stage_start timestamptz not null,
  drop_slug text not null check (drop_slug ~ '^[a-z0-9][a-z0-9-]{0,199}$'),
  chain text not null check (char_length(chain) between 1 and 100),
  price numeric(78, 0) not null check (price >= 0),
  currency_address text not null check (currency_address ~ '^0x[0-9a-f]{40}$'),
  price_version integer not null default 1 check (price_version > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (stage_id, stage_start)
);

insert into public.mint_stage_prices (
  stage_id,
  stage_start,
  drop_slug,
  chain,
  price,
  currency_address,
  price_version,
  first_seen_at,
  last_seen_at
)
select
  stage_id,
  stage_start,
  min(drop_slug),
  'unknown',
  0,
  '0x0000000000000000000000000000000000000000',
  1,
  min(claimed_at),
  max(claimed_at)
from public.free_mint_notifications
group by stage_id, stage_start
on conflict (stage_id, stage_start) do nothing;

create table public.mint_price_change_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  stage_id text not null,
  stage_start timestamptz not null,
  price_version integer not null check (price_version > 1),
  claimed_at timestamptz not null default now(),
  delivered_at timestamptz,
  foreign key (stage_id, stage_start)
    references public.mint_stage_prices(stage_id, stage_start) on delete cascade,
  unique (user_id, stage_id, stage_start, price_version)
);

create index mint_stage_prices_last_seen_idx
  on public.mint_stage_prices (last_seen_at desc);
create index mint_price_change_notifications_user_time_idx
  on public.mint_price_change_notifications (user_id, stage_start desc);

alter table public.mint_stage_prices enable row level security;
alter table public.mint_price_change_notifications enable row level security;

revoke all on table
  public.mint_stage_prices,
  public.mint_price_change_notifications
from anon, authenticated;

grant all on table
  public.mint_stage_prices,
  public.mint_price_change_notifications
to service_role;
