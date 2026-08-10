create table public.wallet_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, wallet_id)
);

create table public.marketplace_activity (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  chain_id integer not null check (chain_id > 0),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  item_index integer not null default 0 check (item_index >= 0),
  activity_type text not null check (activity_type in ('nft_buy', 'nft_sell')),
  marketplace text not null check (char_length(marketplace) between 1 and 100),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-f]{40}$'),
  token_id numeric(78, 0) not null check (token_id >= 0),
  quantity numeric(78, 0) not null default 1 check (quantity > 0),
  counterparty text check (counterparty is null or counterparty ~ '^0x[0-9a-f]{40}$'),
  block_number bigint not null check (block_number >= 0),
  timestamp timestamptz not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  unique (wallet_id, chain_id, tx_hash, log_index, item_index, activity_type)
);

create index wallet_subscriptions_active_wallet_idx
  on public.wallet_subscriptions (wallet_id, user_id) where active;
create index wallet_subscriptions_user_active_idx
  on public.wallet_subscriptions (user_id, created_at) where active;
create index marketplace_activity_wallet_time_idx
  on public.marketplace_activity (wallet_id, timestamp desc);
create index marketplace_activity_chain_block_idx
  on public.marketplace_activity (chain_id, block_number desc);

alter table public.wallet_subscriptions enable row level security;
alter table public.marketplace_activity enable row level security;

revoke all on table
  public.wallet_subscriptions,
  public.marketplace_activity
from anon, authenticated;

grant all on table
  public.wallet_subscriptions,
  public.marketplace_activity
to service_role;
