alter table public.marketplace_activity
  drop constraint if exists marketplace_activity_activity_type_check;

alter table public.marketplace_activity
  add constraint marketplace_activity_activity_type_check
  check (activity_type in ('nft_buy', 'nft_sell', 'nft_mint'));
