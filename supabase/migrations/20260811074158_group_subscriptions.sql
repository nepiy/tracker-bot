create table public.group_subscriptions (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  collection_id uuid not null references public.collections(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chat_id, collection_id)
);

create index group_subscriptions_active_collection_idx
  on public.group_subscriptions (collection_id, chat_id) where active;
create index group_subscriptions_chat_active_idx
  on public.group_subscriptions (chat_id, created_at) where active;

alter table public.group_subscriptions enable row level security;

revoke all on table public.group_subscriptions from anon, authenticated;
grant all on table public.group_subscriptions to service_role;
