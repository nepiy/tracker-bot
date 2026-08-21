create table public.collection_sale_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  collection_id uuid not null references public.collections(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, collection_id)
);

create table public.collection_sale_activity (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.collections(id) on delete cascade,
  chain_id integer not null check (chain_id > 0),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  item_index integer not null check (item_index >= 0),
  marketplace text not null check (char_length(marketplace) between 1 and 120),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-f]{40}$'),
  token_id numeric(78, 0) not null check (token_id >= 0),
  quantity numeric(78, 0) not null check (quantity > 0),
  standard text not null check (standard in ('ERC-721', 'ERC-1155')),
  seller text not null check (seller ~ '^0x[0-9a-f]{40}$'),
  buyer text not null check (buyer ~ '^0x[0-9a-f]{40}$'),
  payment_token text check (payment_token is null or payment_token ~ '^0x[0-9a-f]{40}$'),
  payment_amount numeric(78, 0) check (payment_amount is null or payment_amount >= 0),
  block_number bigint not null check (block_number >= 0),
  timestamp timestamptz not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  unique (collection_id, chain_id, tx_hash, log_index, item_index)
);

create index collection_sale_subscriptions_active_idx
  on public.collection_sale_subscriptions (collection_id, user_id) where active;
create index collection_sale_activity_collection_time_idx
  on public.collection_sale_activity (collection_id, timestamp desc);

alter table public.collection_sale_subscriptions enable row level security;
alter table public.collection_sale_activity enable row level security;

revoke all on table public.collection_sale_subscriptions, public.collection_sale_activity from anon, authenticated;
grant all on table public.collection_sale_subscriptions, public.collection_sale_activity to service_role;
