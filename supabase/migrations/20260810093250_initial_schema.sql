create extension if not exists pgcrypto;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique,
  created_at timestamptz not null default now()
);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  opensea_slug text not null unique check (opensea_slug ~ '^[a-z0-9][a-z0-9-]{0,199}$'),
  name text not null check (char_length(name) between 1 and 300),
  chain text not null check (chain in ('ethereum', 'base', 'robinhood')),
  chain_id integer not null check (chain_id > 0),
  contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  unique (chain_id, contract_address)
);

create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null check (chain_id > 0),
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  unique (chain_id, address)
);

create table public.collection_wallets (
  collection_id uuid not null references public.collections(id) on delete cascade,
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  relationship text not null check (relationship in (
    'contract_creator', 'deployment_initiator', 'contract_owner',
    'royalty_receiver', 'mint_proceeds_receiver', 'withdrawal_destination',
    'treasury', 'likely_dev', 'tracked_fallback'
  )),
  confidence smallint not null default 100 check (confidence between 0 and 100),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  primary key (collection_id, wallet_id, relationship)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  collection_id uuid not null references public.collections(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, collection_id)
);

create table public.processed_transactions (
  chain_id integer not null check (chain_id > 0),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  processed_at timestamptz not null default now(),
  primary key (chain_id, tx_hash)
);

create table public.wallet_activity (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  chain_id integer not null check (chain_id > 0),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint not null check (block_number >= 0),
  from_address text not null check (from_address ~ '^0x[0-9a-f]{40}$'),
  to_address text check (to_address is null or to_address ~ '^0x[0-9a-f]{40}$'),
  value numeric(78, 0) not null default 0 check (value >= 0),
  activity_type text not null check (activity_type in (
    'native_transfer', 'erc20_transfer', 'nft_transfer', 'swap', 'bridge', 'contract_interaction'
  )),
  timestamp timestamptz not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  unique (wallet_id, chain_id, tx_hash)
);

create table public.chain_sync_state (
  chain_id integer primary key check (chain_id > 0),
  last_processed_block bigint not null check (last_processed_block >= 0),
  updated_at timestamptz not null default now()
);

create index subscriptions_active_collection_idx
  on public.subscriptions (collection_id, user_id) where active;
create index collection_wallets_wallet_idx on public.collection_wallets (wallet_id, collection_id);
create index wallet_activity_wallet_time_idx on public.wallet_activity (wallet_id, timestamp desc);
create index wallet_activity_chain_block_idx on public.wallet_activity (chain_id, block_number desc);

alter table public.users enable row level security;
alter table public.collections enable row level security;
alter table public.wallets enable row level security;
alter table public.collection_wallets enable row level security;
alter table public.subscriptions enable row level security;
alter table public.processed_transactions enable row level security;
alter table public.wallet_activity enable row level security;
alter table public.chain_sync_state enable row level security;

revoke all on table
  public.users,
  public.collections,
  public.wallets,
  public.collection_wallets,
  public.subscriptions,
  public.processed_transactions,
  public.wallet_activity,
  public.chain_sync_state
from anon, authenticated;

grant all on table
  public.users,
  public.collections,
  public.wallets,
  public.collection_wallets,
  public.subscriptions,
  public.processed_transactions,
  public.wallet_activity,
  public.chain_sync_state
to service_role;
