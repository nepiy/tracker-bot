create table public.mint_price_change_events (
  stage_id text not null,
  stage_start timestamptz not null,
  price_version integer not null check (price_version > 1),
  previous_price numeric(78, 0) not null check (previous_price = 0),
  new_price numeric(78, 0) not null check (new_price > 0),
  new_currency_address text not null check (new_currency_address ~ '^0x[0-9a-f]{40}$'),
  detected_at timestamptz not null default now(),
  primary key (stage_id, stage_start, price_version),
  foreign key (stage_id, stage_start)
    references public.mint_stage_prices(stage_id, stage_start) on delete cascade
);

alter table public.mint_price_change_notifications
  add foreign key (stage_id, stage_start, price_version)
  references public.mint_price_change_events(stage_id, stage_start, price_version)
  on delete cascade;

create index mint_price_change_events_detected_idx
  on public.mint_price_change_events (detected_at desc);

alter table public.mint_price_change_events enable row level security;

revoke all on table public.mint_price_change_events from anon, authenticated;
grant all on table public.mint_price_change_events to service_role;
