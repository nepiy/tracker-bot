create table public.nft_price_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  opensea_slug text not null check (opensea_slug ~ '^[a-z0-9][a-z0-9-]{0,199}$'),
  collection_name text not null check (char_length(collection_name) between 1 and 300),
  chain text not null check (char_length(chain) between 1 and 100),
  contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
  target_price numeric(38, 18) not null check (target_price > 0),
  initial_floor_price numeric(38, 18) not null check (initial_floor_price > 0),
  last_floor_price numeric(38, 18) check (last_floor_price is null or last_floor_price >= 0),
  currency_symbol text not null check (char_length(currency_symbol) between 1 and 20),
  direction text not null check (direction in ('at_or_below', 'at_or_above')),
  status text not null default 'active' check (status in ('active', 'sending', 'triggered', 'cancelled')),
  claimed_at timestamptz,
  triggered_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'sending') = (claimed_at is not null)),
  check ((status = 'triggered') = (triggered_at is not null))
);

create unique index nft_price_alerts_unique_active_target_idx
  on public.nft_price_alerts (user_id, opensea_slug, target_price, direction)
  where status in ('active', 'sending');
create index nft_price_alerts_active_collection_idx
  on public.nft_price_alerts (opensea_slug, created_at)
  where status = 'active';
create index nft_price_alerts_user_active_idx
  on public.nft_price_alerts (user_id, created_at)
  where status in ('active', 'sending');

alter table public.nft_price_alerts enable row level security;

revoke all on table public.nft_price_alerts from anon, authenticated;
grant select, insert, update, delete on table public.nft_price_alerts to service_role;
