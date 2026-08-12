create table public.telegram_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique check (char_length(event_key) between 1 and 500),
  telegram_id bigint not null,
  message_text text not null check (char_length(message_text) between 1 and 4096),
  status text not null default 'pending' check (status in ('pending', 'sending', 'delivered')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'sending') = (claimed_at is not null)),
  check ((status = 'delivered') = (delivered_at is not null))
);

create index telegram_notification_outbox_pending_idx
  on public.telegram_notification_outbox (next_attempt_at, created_at)
  where status = 'pending';

create index telegram_notification_outbox_sending_idx
  on public.telegram_notification_outbox (claimed_at)
  where status = 'sending';

alter table public.telegram_notification_outbox enable row level security;

revoke all on table public.telegram_notification_outbox from anon, authenticated;
grant select, insert, update, delete on table public.telegram_notification_outbox to service_role;
