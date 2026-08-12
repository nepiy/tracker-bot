alter table public.nft_price_alerts
  add column currency_address text
    check (currency_address is null or currency_address ~ '^0x[0-9a-f]{40}$'),
  add column last_usd_rate numeric(38, 18)
    check (last_usd_rate is null or last_usd_rate >= 0),
  add column last_usd_rate_at timestamptz;

-- OpenSea represents the native asset with the zero address. This lets existing
-- ETH floor alerts begin receiving refreshed USD quotes on the next watcher poll.
update public.nft_price_alerts
set currency_address = '0x0000000000000000000000000000000000000000'
where currency_address is null
  and upper(currency_symbol) = 'ETH';
