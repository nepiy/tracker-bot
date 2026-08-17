# OpenSea Dev Wallet Tracker Bot

A production-oriented Telegram bot that resolves NFT collections from OpenSea, tracks inferred team-wallet activity, and lets users monitor any EVM wallet for NFT mints and marketplace buys/sells.

OpenSea collection discovery is intentionally limited to:

- Ethereum (`1`)
- Robinhood Chain (`4663`)

The inferred dev address is monitored on Ethereum and Robinhood Chain by default. Base tracking is disabled. Additional EVM monitoring networks can be added with RPC/explorer configuration without enabling OpenSea discovery on those chains.

The project uses TypeScript, Node.js 22+, grammY, viem, Supabase/PostgreSQL, the OpenSea API, Etherscan v2, Blockscout v2, and DEX Screener's public API.

## Current features

- Interactive Telegram dashboard with inline navigation and a front-page **Add to Group** action
- Fresh OpenSea free-mint browser with separate paginated **Upcoming** and **Live now** views
- Personal **Active Tracking** overview combining collections, wallets, floor targets, and free-mint status
- Read-only collection research from an OpenSea URL or Ethereum/Robinhood NFT contract
- OpenSea wallet eligibility checks that verify the submitted wallet through the official OAuth browser flow and show only eligible non-public mint stages
- Collection owner, live mint-or-floor details with approximate USD conversion, top offer, 24-hour volume, and floor-price change reporting
- Up to five additional OpenSea collections attributed to the same owner profile, omitted when none exist
- Cross-chain creator-token history for deployer-created ERC-20 contracts with detected DEX markets, omitted when none exist
- Personal one-time floor-price targets for both downward and upward price movements, with live approximate USD values throughout the alert flow
- Automatic one-time target expiration only after its message is durably queued, with confirmed cancellation and delivery retries
- OpenSea-link input prompt plus direct URL-paste support
- Collection dashboard with network, contract, inferred wallet, OpenSea, and explorer details
- Deterministic contract deployment analysis with clearly separated verified facts and inferred wallet signals
- Automatic outgoing-activity alerts for active subscribers, scoped to each collection's own chain
- Direct wallet subscriptions across Ethereum and Robinhood Chain
- Automatic NFT mint alerts plus buy/sell alerts for recognized Seaport marketplace settlements
- High-risk `ALERT` notifications for native sends or ERC-20 swaps above 90% of the pre-block asset balance
- High-risk alerts for recognized bridge calls and configured Binance, Bybit, or other CEX addresses
- Optional cross-chain monitoring of inferred dev addresses without cross-chain collection-alert fan-out
- Telegram group collection alerts managed only by verified group administrators
- Opt-in OpenSea free-mint alerts for public, GTD, and FCFS zero-price stages starting within the next hour
- Follow-up alerts when an announced free stage changes to any positive mint price
- Personal `/settings` toggle, GMT mint times, access labeling, and per-user/stage deduplication
- Activity categories and filters for sends, swaps, and bridges
- ERC-20 and NFT transfer classification plus safe fallback labels for unknown contract calls
- Restart-safe watcher cursors and transaction deduplication in Supabase
- Robinhood RPC failover to the public chain endpoint when the configured provider is unavailable or throttled
- Live-priority newest-block scanning so a historical backlog cannot delay current wallet alerts
- Durable Telegram notification outbox with stale-claim recovery and exponential delivery retries
- Bounded per-user/global rate limiting, concurrent-handler limits, and structured error logging with URL, credential, and Telegram-identifier redaction
- Private-chat enforcement for personal collections, wallets, activity, settings, and floor-alert dashboards
- GitHub Actions validation on pushes to `main` and pull requests

## What it does

Open `/start`, tap **Add Collection**, and send the full OpenSea collection link. You can also paste the link directly. The bot will:

1. Validate the URL and extract the slug without fetching an arbitrary host.
2. Resolve the collection name, chain, and contract through OpenSea's v2 API.
3. Resolve the direct contract creator and creation transaction through the configured explorer.
4. Read the creation transaction to distinguish a factory contract from its external initiator.
5. inspect deterministic contract signals such as `owner()`, ERC-2981 `royaltyInfo()`, common primary-sale recipient methods, withdrawal destinations, and treasury methods.
6. Score candidates and clearly label the selected wallet as inferred.
7. Persist one subscription per Telegram user and collection.
8. Monitor each unique wallet once, store outgoing activity, and fan alerts out to every active subscriber.

For research without subscribing, tap **Research NFT** or run `/info`. Send either an OpenSea collection URL or an NFT contract on Ethereum or Robinhood Chain. The bot resolves the official OpenSea collection and returns its link, contract, chain, OpenSea collection-owner wallet, top collection offer, 24-hour volume, and 24-hour floor-price change. When a mint is active or its next stage begins within 12 hours, mint status, access, price, GMT schedule, wallet limit, and available supply details replace the floor-price line. Otherwise, the current floor price is shown. If the owner's OpenSea profile is attributed as the creator of other collections, up to five are included; the section is omitted when there are none.

The same research request also resolves the NFT contract's verified deployment initiator and scans that wallet's direct contract-creation history across every configured EVM monitoring chain. Each created contract is checked for ERC-20 metadata and then matched against DEX Screener. When matches exist, the bot sends the full detected history in Telegram-safe follow-up messages with token name, symbol, chain, creation date, contract, explorer link, DEX link, and available price/liquidity/market-cap data. No creator-token section is sent when there are no matches. This check does not require another API key.

For a one-time floor target, tap **Floor Alerts** or run `/pricealert`. After resolving the collection, enter a target in the floor-price currency. The prompt, confirmation, active-alert pages, consolidated **Active Tracking** view, and automatic target-reached notification show an approximate USD equivalent whenever OpenSea supplies a valid current quote. A target below the current floor triggers when the floor falls to or below it; a target above the current floor triggers when the floor rises to or above it. The watcher checks each unique collection once per polling cycle, refreshes the floor currency's USD quote, and durably queues the target owner's personal Telegram message after the threshold is crossed. The one-time target then expires, while the outbox continues retrying until Telegram accepts the message. Use `/pricealerts` to review active targets. Opening an alert shows its details; cancellation requires a separate confirmation so inspecting a target cannot remove it accidentally.

The bot can also be added to a Telegram group. Tap **Add to Group** at the top of the dashboard to open Telegram's group picker. A verified group admin can subscribe the group to a collection, and every active group subscription receives the same dev-wallet and high-risk alerts in the group chat.

The `/list` dashboard then lets the user inspect the collection, open OpenSea or the chain explorer, view activity, stop tracking, add another collection, or return to the main menu.

Free-mint discovery is optional and disabled for every user by default. Open **Settings** or run `/settings` to enable it for your Telegram account. The watcher reads OpenSea's official upcoming-drops calendar, falls back to featured-drop details when that page is empty, checks the detailed mint stages, and sends one notification when a zero-price public, GTD, or FCFS stage is scheduled to begin within the next hour. It persists the observed stage price; if that same stage later changes from free to any positive amount, the bot sends a `MINT PRICE CHANGED` warning on the next polling cycle. The watcher scans on its configured poll interval (10 minutes by default) so newly listed stages are picked up without waiting an hour. Each `(user, stage, start time)` is durably claimed once, so the same stage is not announced again on the next scan. The warning shows the token amount and an approximate USD value when OpenSea provides a usable quote. Start and end times are always displayed in GMT. Network gas can still apply. Other private, creator-reserve, and team-only stages remain excluded.

Users can also tap **Free Mints** or run `/freemints` without enabling automatic alerts. The browser provides separate **Upcoming** and **Live now** views, paginates qualifying stages returned by OpenSea's drop calendar, and performs a fresh API check on every view, refresh, or page action. A mint newly listed after an earlier check therefore appears on the next check. Upcoming covers future public, GTD, and FCFS zero-price stages across OpenSea's supported chains; if OpenSea's upcoming page is empty or omits a stage, the bot also checks featured-drop details. Live now combines OpenSea's featured, upcoming, and recently-minted calendars, checks detailed drop supply, and excludes stages whose total supply has reached their maximum. Each entry includes its collection, chain, stage, GMT schedule, and direct OpenSea link. Collection and wallet tracking remain limited to Ethereum and Robinhood Chain.

For direct wallet tracking, tap **Add Wallet**, paste any valid EVM address, and select Ethereum, Robinhood Chain, or both. The watcher recognizes canonical Seaport settlement contracts, inspects the successful transaction receipt, and labels NFT transfers into the wallet as buys and transfers out as sells. Plain wallet-to-wallet NFT transfers are not mislabeled as marketplace sales.

For allowlist discovery, tap **Eligibility** or run `/eligibility`. Send the wallet address you want to check. The bot opens OpenSea's official browser authorization flow with only the `read:eligibility` scope. Sign in or connect the same wallet in the OpenSea page, complete the read-only authorization, and return to Telegram. The bot compares the wallet claim in OpenSea's token with the submitted address before querying any eligibility data. Results include only currently active or next-24-hour allowlist, GTD, FCFS, presale, whitelist, reserved, signed, or other non-public stages; a public-mint-only match is never shown. Tokens are held in memory only for the short check and revoked after the result is returned. Never enter a seed phrase or private key anywhere.

To review everything currently enabled for your account, tap **Active Tracking** on the front page or run `/active`. This consolidated dashboard shows active collection dev-wallet monitoring, direct wallets grouped across their selected networks, one-time floor targets and their status, and whether optional free-mint alerts are enabled. Its buttons open each management page directly. Long sections show the first eight items plus the full active count, keeping the Telegram message within its size limit; open the corresponding management page to see every item. Group subscriptions remain managed inside each Telegram group by its admins.

Incoming transactions do not alert. A transaction only qualifies when its top-level `from` address equals a currently watched address. The separate watcher process must be running for automatic detection and notifications.

## Architecture

```text
Telegram bot process
  ├─ OpenSea collection information lookup
  │   ├─ URL or supported-chain contract resolution
  │   ├─ owner/profile and related-collection lookup
  │   ├─ drop, floor, offer, volume, and price-history data
  │   └─ deployment initiator history across configured chains
  │       └─ ERC-20 metadata + DEX market matching
  └─ OpenSea tracking resolver
      └─ chain adapter
          ├─ explorer deployment adapter
          ├─ viem RPC client
          └─ dev-wallet analyzer
              └─ Supabase repositories

  └─ OpenSea eligibility command
      ├─ OAuth authorization-code + PKCE (read:eligibility only)
      ├─ public callback listener
      ├─ wallet-claim/address match
      ├─ bounded active/upcoming drop discovery
      └─ non-public stage filtering + one-time token revocation

Watcher process (one runner per chain)
  └─ deduplicated active collection + direct wallet subscriptions
      ├─ live-priority newest-block window (independent in-memory cursor)
      │   └─ current activity first + database deduplication
      └─ restart-safe historical block cursor
          ├─ outgoing collection-wallet transaction filter
          │   └─ activity decoder + notification fan-out
          ├─ tracked-wallet NFT transfer filters
          │   └─ ERC-721/ERC-1155 decoding + Seaport verification + mint/buy/sell alerts
          └─ high-risk evaluator
              ├─ pre-block native-balance percentage
              ├─ recognized bridge call
              └─ configured CEX destination label

Free-mint watcher (same watcher process)
  └─ only polls when at least one user has opted in
      └─ official upcoming drops + detailed mint stages
          ├─ persistent public-stage price snapshot
          ├─ free alert + per-user/stage claim
          └─ free-to-paid transition alert + token/USD formatting

NFT floor-price watcher (same watcher process)
  └─ unique active OpenSea collections
      ├─ official collection stats floor lookup
      ├─ live floor-currency USD quote with persisted last-known fallback
      ├─ upward/downward threshold evaluation
      └─ atomic delivery claim + one-time expiration

Telegram delivery worker (same watcher process)
  └─ durable Supabase outbox
      ├─ one-second pending-message polling
      ├─ atomic delivery claims + stale-claim recovery
      ├─ Telegram API confirmation
      └─ exponential retry after timeout, rate limit, or temporary failure
```

Important source areas:

- `src/opensea`: strict URL parsing and OpenSea resolution
- `src/blockchain`: chain configuration, viem clients, deployment analysis, scoring, and activity decoding
- `src/explorers`: Etherscan and Blockscout adapters
- `src/database`: service-role client and focused repositories
- `src/bot`: Telegram commands, URL handling, rate limiting, and inline keyboards
- `src/watcher`: durable block polling, transaction processing, and notifications
- `supabase/migrations`: schema, constraints, indexes, and RLS

## Prerequisites

- Node.js 22 or newer
- npm
- A Telegram bot token
- A Supabase project
- An OpenSea API key
- Production RPC endpoints for Ethereum and Robinhood Chain
- An Etherscan API key is recommended for Ethereum contract-creation lookups

No OpenSea OAuth secret or private key is required. The bot uses OpenSea's public OAuth client and a short-lived authorization-code + PKCE session. Each user must approve the read-only sign-in on OpenSea when running `/eligibility`.

The public Robinhood RPC in `.env.example` is rate-limited. Use a production provider for deployment.

## Telegram BotFather setup

1. Open `@BotFather` in Telegram.
2. Run `/newbot` and follow the prompts.
3. Copy the token into `TELEGRAM_BOT_TOKEN`.
4. Optionally use `/setcommands` with:

   ```text
   start - Open the bot dashboard
   help - Show help
   info - Research an OpenSea collection
   pricealert - Create a one-time NFT floor target
   pricealerts - View or cancel NFT floor targets
   track - Track an OpenSea collection
   list - Open tracked collections
   stop - Stop tracking a collection
   activity - View sends, swaps, and bridges
   wallet - Track a wallet's NFT mints and marketplace buys/sells
   wallets - List or stop tracked wallets
   eligibility - Check a wallet's OpenSea allowlist eligibility
   grouptrack - Track a collection in this group (admins only)
   grouplist - List or stop this group's collection alerts (admins only)
   settings - Customize personal notification preferences
   freemints - Browse fresh upcoming and live OpenSea free mints
   ```

Do not put the token in source control or Railway build logs.

## OpenSea API key

Create an API key using OpenSea's current developer flow and set `OPENSEA_API_KEY`. The implementation calls:

```text
GET https://api.opensea.io/api/v2/collections/{slug}
GET https://api.opensea.io/api/v2/collections/{slug}/stats
GET https://api.opensea.io/api/v2/collections/{slug}/floor_prices
GET https://api.opensea.io/api/v2/offers/collection/{slug}
GET https://api.opensea.io/api/v2/chain/{chain}/contract/{address}
GET https://api.opensea.io/api/v2/chain/{chain}/contract/{address}/nfts/{identifier}
GET https://api.opensea.io/api/v2/accounts/resolve/{owner}
GET https://api.opensea.io/api/v2/collections?creator_username={username}
GET https://api.opensea.io/api/v2/drops?type=upcoming
GET https://api.opensea.io/api/v2/drops/{slug}
GET https://api.opensea.io/api/v2/drops/{slug}/eligibility
GET https://api.opensea.io/api/v2/chain/{chain}/token/{address}
X-API-KEY: ...
```

It does not scrape OpenSea HTML.

## Supabase setup

1. Create a Supabase project.
2. Copy the project API URL and a modern backend secret key into `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. The legacy `SUPABASE_SERVICE_ROLE_KEY` remains supported while migrating keys.

   The URL must use the project API origin:

   ```text
   https://YOUR_PROJECT_REF.supabase.co
   ```

   Do not use the dashboard URL (`https://supabase.com/dashboard/project/...`).

3. Apply the migration with the included CLI:

   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push --linked
   npx supabase migration list --linked
   ```

Alternatively, run the SQL migration in the Supabase SQL editor.

Every application table has RLS enabled. `anon` and `authenticated` have no table grants or policies because both processes are trusted backend services using a backend secret key. Default privileges also keep future tables, sequences, and functions private until a migration explicitly grants backend access. Never expose a backend key to a browser or Telegram user.

The schema contains:

- `users`
- `collections`
- `wallets`
- `collection_wallets`
- `subscriptions`
- `processed_transactions`
- `wallet_activity`
- `chain_sync_state`
- `wallet_subscriptions`
- `marketplace_activity`
- `group_subscriptions`
- `free_mint_notifications`
- `mint_stage_prices`
- `mint_price_change_events`
- `mint_price_change_notifications`
- `nft_price_alerts`
- `telegram_notification_outbox`

The `users.free_mint_alerts_enabled` preference defaults to `false`. Wallets use a unique `(chain_id, address)` key. Collection and direct-wallet subscriptions are deduplicated per user, while outgoing activity, marketplace activity, free-mint notifications, observed stage prices, price-transition notifications, active floor targets, and queued Telegram messages use transaction/log/stage/version/target/event uniqueness constraints for restart-safe processing. New floor-target rows move through `active → sending → triggered`; `sending` remains visible in the dashboard as **Delivering notification** until the alert is safely inserted into the outbox. Telegram requests use a 15-second timeout instead of grammY's 500-second default. The outbox moves through `pending → sending → delivered`, recovers interrupted claims after one minute, retries failed sends with capped exponential backoff, and retains delivered rows for 30 days for deduplication and auditability.

## Environment variables

Copy the template:

```bash
cp .env.example .env
```

Required:

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather token used by both processes |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Recommended modern backend-only Supabase secret (`sb_secret_...`) |
| `OPENSEA_API_KEY` | OpenSea v2 API key |
| `ETHEREUM_RPC_URL` | Ethereum JSON-RPC endpoint |
| `ROBINHOOD_RPC_URL` | Robinhood Chain JSON-RPC endpoint |
| `ETHERSCAN_API_KEY` | Recommended Etherscan v2 key for Ethereum; public Blockscout is used as fallback |

Optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENSEA_OAUTH_CLIENT_ID` | `379893200225068569` | Public OpenSea OAuth client used by the read-only wallet eligibility flow |
| `OPENSEA_OAUTH_REDIRECT_URI` | unset | Public HTTPS callback URL for the bot service, such as `https://your-bot.up.railway.app/oauth/opensea/callback`; required for eligibility |
| `BLOCKSCOUT_API_KEY` | unset | Bearer token for a protected Blockscout instance |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Legacy backend-key fallback; use `SUPABASE_SECRET_KEY` for new deployments |
| `MONITORING_CHAINS_JSON` | `[]` | Additional EVM RPC/explorer definitions used only for cross-chain wallet monitoring |
| `CEX_ADDRESSES_JSON` | `[]` | Verified, chain-specific CEX deposit/hot-wallet labels used for high-risk alerts |
| `WATCHER_POLL_INTERVAL_MS` | `12000` | Delay after a successful chain scan |
| `WATCHER_BOOTSTRAP_LOOKBACK_BLOCKS` | `10` | Blocks scanned when a chain cursor is first created |
| `WATCHER_MAX_BACKLOG_BLOCKS` | `5000` | Maximum cursor lag before the watcher fast-forwards to the recent bootstrap window |
| `WATCHER_SCAN_BATCH_SIZE` | `250` | Maximum blocks per watcher scan batch; active direct-wallet NFT tracking automatically checkpoints every provider-compatible 5-block range |
| `WATCHER_BLOCK_FETCH_CONCURRENCY` | `16` | Maximum concurrent block requests while scanning dev-wallet transactions |
| `WATCHER_CONFIRMATIONS` | `1` | Head blocks held back to reduce reorg risk |
| `WATCHER_LIVE_POLL_INTERVAL_MS` | `2000` | Delay between successful live-priority newest-block scans; minimum 1 second |
| `WATCHER_LIVE_LOOKBACK_BLOCKS` | `100` | Maximum newest-block window scanned independently from the historical cursor |
| `WATCHER_SUBSCRIPTION_REPLAY_BLOCKS` | `1000` | Wider one-time replay after the active direct-wallet subscription set changes |
| `WATCHER_RECONCILE_INTERVAL_MS` | `30000` | Interval for replaying the recent live window as a missed-event safety net |
| `WATCHER_MARKETPLACE_LOG_QUERY_INTERVAL_MS` | `125` | Minimum spacing per chain between marketplace RPC log queries to avoid provider bursts |
| `FREE_MINT_LOOKAHEAD_HOURS` | `1` | Future window searched for automatic free-mint alerts; 1-24 hours |
| `FREE_MINT_POLL_INTERVAL_MS` | `600000` | Opt-in OpenSea upcoming-drop scan interval; minimum 60 seconds |
| `PRICE_ALERT_POLL_INTERVAL_MS` | `60000` | Active NFT floor-target scan interval; minimum 30 seconds |
| `TELEGRAM_RATE_LIMIT_PER_MINUTE` | `8` | Per-user request limit per process |
| `TELEGRAM_GLOBAL_RATE_LIMIT_PER_MINUTE` | `240` | Bot-wide accepted-update ceiling that limits multi-account API bursts |
| `TELEGRAM_MAX_CONCURRENT_UPDATES` | `20` | Maximum Telegram updates executing handlers concurrently |
| `LOG_LEVEL` | `info` | Pino structured-log level |

Environment values are validated at startup. Production database, RPC, and explorer endpoints must use HTTPS and cannot contain HTTP username/password credentials. Credential-bearing URLs, authorization values, Telegram IDs, and known token formats are redacted from structured logs and persisted delivery errors.

### Additional monitoring chains

OpenSea resolution and built-in tracking are limited to Ethereum and Robinhood Chain. Base chain tracking is disabled; any legacy Base entry in this setting is ignored. To follow the inferred dev address on additional EVM chains, add their RPC and explorer information as a JSON array. For example:

```dotenv
MONITORING_CHAINS_JSON=[{"chainId":42161,"name":"Arbitrum One","rpcUrl":"https://YOUR_ARBITRUM_RPC","explorerUrl":"https://arbiscan.io","nativeSymbol":"ETH"},{"chainId":10,"name":"Optimism","rpcUrl":"https://YOUR_OPTIMISM_RPC","explorerUrl":"https://optimistic.etherscan.io","nativeSymbol":"ETH"}]
```

Any EVM chain can be added this way, but each chain requires a reliable RPC endpoint. Restart the watcher after changing the list. The watcher automatically creates a chain-specific wallet record for the same inferred dev address, but it does not send a collection alert from an added chain unless that collection itself is on that chain.

### CEX destination labels

CEX deposit addresses are often account- and network-specific, so the project does not pretend that a small static list covers Binance, Bybit, or every exchange. Add addresses you have verified:

```dotenv
CEX_ADDRESSES_JSON=[{"chainId":1,"address":"0xYOUR_BINANCE_DEPOSIT_ADDRESS","exchange":"Binance"}]
```

The registry supports any exchange name and any configured chain. Addresses are normalized and matched against native, ERC-20, and NFT transfer recipients. The labels themselves are public configuration; never place exchange API secrets in this value.

## Run locally

Install pinned dependencies and verify the build:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Run the bot in one terminal:

```bash
npm run dev:bot
```

Run the watcher in a second terminal:

```bash
npm run dev:watcher
```

Both processes are required for the complete product:

- The **bot** handles Telegram menus, commands, collection analysis, subscriptions, and activity queries.
- The **watcher** polls supported chains, classifies outgoing transactions, stores activity, queues automatic alerts, retries Telegram delivery, checks OpenSea mint stages for users who opted in, and evaluates active floor-price targets.

Running only the bot allows collection management but does not produce real-time blockchain alerts.

Production commands:

```bash
npm run start:bot
npm run start:watcher
```

Only run one bot long-polling process for a Telegram token. Multiple watcher replicas are not currently supported because transaction claiming and activity insertion are separate database operations.

## Telegram commands

- `/start`: open the inline-button dashboard
- `/help`: setup and command help
- `/info <OpenSea URL or NFT contract>`: return read-only collection, owner, mint-or-floor, offer, volume, price-change, related-collection information, and detected creator-token history; `/info` by itself opens the validated input prompt
- `/pricealert <OpenSea URL or NFT contract>`: resolve the current floor and create a personal one-time upward or downward target; `/pricealert` by itself opens the collection prompt
- `/pricealerts`: list active floor targets and cancel individual alerts
- `/track <OpenSea URL>`: analyze and subscribe; `/track` by itself opens an OpenSea-link input prompt
- Paste an OpenSea collection URL directly: same behavior as `/track`
- `/list`: interactive tracked-collections dashboard with collection, contract, wallet, OpenSea, and explorer details
- `/stop`: inline collection picker that deactivates only that user's subscription
- `/activity`: interactive collection picker with All, Sends, Swaps, and Bridges filters
- `/wallet <address>`: choose Ethereum, Robinhood Chain, or both for NFT mint and marketplace buy/sell alerts
- Paste an EVM wallet address directly: opens the same network picker
- `/wallets`: list direct wallet subscriptions and stop individual network subscriptions
- `/grouptrack <OpenSea URL>`: add a collection to the current Telegram group; group admins only
- `/grouplist`: list or stop the current group's tracked collections; group admins only
- `/settings`: turn personal OpenSea free-mint alerts on or off; off by default
- `/freemints`: freshly browse paginated upcoming or currently-live public, GTD, and FCFS free mints from OpenSea
- `/active`: show all personal collection, wallet, floor-target, and free-mint monitoring in one dashboard

The dashboard keeps common actions in inline buttons: add the bot to a group, open **Active Tracking**, research a collection, create or manage floor targets, add a collection or wallet, use **Tracking Collection** and **Tracking Wallet** to inspect active subscriptions, review activity, stop tracking, refresh, and return to the main menu. Research, price alerts, collection tracking, and wallet tracking use separate validated reply-input flows, so a contract sent to one prompt is not mistaken for another action.

Stopping one subscription never disables another user's subscription. The watcher derives its deduplicated wallet set from all active subscriptions.

### Telegram group setup

1. In a private chat with the bot, tap **Add to Group** and then **Choose a Group**.
2. Promote the bot to a group administrator. This lets it reliably verify whether the person changing subscriptions is a group admin.
3. A group admin sends `/track https://opensea.io/collection/your-collection` or `/grouptrack` and then replies with the OpenSea URL.
4. Use `/grouplist` to review active group alerts or stop one.

Only Telegram members whose current role is `creator` or `administrator` can create, view, or stop a group subscription. The check is performed live with Telegram for every group command and inline action. In groups where Telegram privacy mode is enabled, use the slash commands; the bot may not receive ordinary pasted URLs.

## Automatic activity alerts

For each supported chain, the watcher:

1. Resumes from the last persisted block cursor.
2. Loads the deduplicated set of wallets used by active subscriptions.
3. Selects top-level transactions whose `from` address is a watched wallet.
4. Claims each transaction once to prevent duplicate processing.
5. Classifies it as a native send, ERC-20 transfer, NFT transfer, swap, bridge, or contract interaction.
6. Stores the activity in Supabase.
7. Durably queues a Telegram message for every active personal subscriber and subscribed Telegram group whose collection is on that same chain.

Alerts include the collection, chain, inferred wallet, action, destination/router/bridge, native value with a live approximate USD equivalent when available, transaction hash, and explorer link. For example, `0.002917 ETH (≈ $X.XX)`. A swap that spends more than 90% of the wallet's pre-transaction ERC-20 balance also uses the high-risk `ALERT` heading; the notification names the affected token contract and percentage. Swap and bridge alerts use distinct labels and icons. The same durable outbox handles ordinary dev activity, high-risk alerts, group fan-out, and direct-wallet marketplace buys/sells. A failed Telegram request remains pending and is retried automatically; the stored activity also remains accessible through `/activity`.

Direct wallet subscriptions use a separate NFT-activity path. The watcher detects ERC-721 and ERC-1155 transfers from the zero address into a tracked wallet as `nft_mint`, including mints outside marketplace settlement contracts. For marketplace activity, it first queries NFT transfers involving tracked wallets and verifies canonical Seaport settlements plus paid transactions routed through marketplace aggregators. Confirmed incoming transfers are recorded as `nft_buy` and outgoing transfers as `nft_sell`; unpaid direct wallet-to-wallet transfers remain ignored. Mint, buy, and sell alerts include the wallet, network, OpenSea NFT name and item link, counterparty when applicable, transaction hash, and explorer link. If OpenSea metadata is temporarily unavailable, the alert still sends with a deterministic `NFT #<token ID>` label and constructed item link.

The watcher now runs three complementary chain paths. The live-priority RPC path is dedicated to direct-wallet NFT mints and marketplace activity; it does not fetch or decode collection dev-wallet activity, keeping wallet purchase alerts independent from the heavier historical scanner. It checks the newest confirmed window every two seconds with an independent in-memory cursor. The durable RPC path continues from the persisted Supabase cursor to backfill older blocks. A third, independent Blockscout reconciliation loop checks the preceding 24 hours of indexed NFT transfers every `WATCHER_RECONCILE_INTERVAL_MS` on Ethereum and Robinhood. It repairs events missed because an RPC rejected `eth_getLogs`, throttled requests, restarted after the short live window, or advanced a cursor under an older detector. The explorer loop does not depend on the configured RPC URL and retries individual transaction lookups without blocking the fast scanner.

All three paths use the same Supabase activity claims and Telegram-outbox uniqueness keys, so overlapping recovery cannot send the same alert twice. Targeted RPC NFT-transfer logs are requested in 5-block ranges, including for QuickNode's Robinhood endpoint; only candidate tracked-wallet transactions require receipt fetches, those fetches use bounded concurrency, and transient log/receipt failures use bounded exponential backoff. If the durable cursor falls farther behind than `WATCHER_MAX_BACKLOG_BLOCKS`, it fast-forwards to the recent bootstrap window while the live-priority and indexed paths continue handling current alerts. The Telegram outbox checks pending messages every second and retains its normal retry behavior after delivery failures. No additional Railway variable is required for indexed recovery; `BLOCKSCOUT_API_KEY` remains optional.

Collection dev-wallet notifications are promoted to `🚨🚨 ALERT: HIGH-RISK DEV ACTIVITY 🚨🚨` when at least one rule matches:

- Native value sent is strictly greater than 90% of the wallet balance at the end of the preceding block.
- The transaction matches a recognized bridge selector.
- The final transfer recipient matches a chain-specific entry in `CEX_ADDRESSES_JSON`.

The alert lists every matching reason, so a large bridge or a transfer to a configured Binance/Bybit address can show multiple warnings.

## One-time NFT floor-price alerts

Floor targets are personal and do not require the collection to be subscribed for dev-wallet tracking:

1. Open **Floor Alerts**, choose **Add price alert**, and send an OpenSea collection URL or a supported-chain NFT contract.
2. The bot reads the current floor and floor-currency USD quote from OpenSea, shows both values, and asks for a positive target with up to 18 decimal places.
3. The bot chooses the direction automatically: a lower target uses `floor <= target`; a higher target uses `floor >= target`.
4. The watcher groups active targets by collection so users watching the same collection share one OpenSea stats request per cycle. It also caches live USD quote requests per chain and currency during that cycle.
5. When a threshold is crossed, the watcher atomically claims that user's target and inserts a uniquely keyed message into the durable Telegram outbox. The dashboard keeps this target visible with a **Delivering notification** status while it is being queued.
6. A successful outbox insert changes the target to `triggered`, so it cannot schedule another message. Telegram timeouts, rate limits, and temporary failures do not remove that queued message; the delivery worker retries it automatically.
7. Opening an alert shows its saved direction, initial floor, latest checked floor, current approximate USD values, and status. Cancellation requires an explicit confirmation.

The notification includes the collection, chain, target, observed floor, live approximate USD equivalents, direction, and OpenSea link. `/pricealerts` shows active and currently delivering targets; triggered and manually cancelled targets are retained in Supabase as inactive records. If OpenSea temporarily cannot provide a usable quote, the bot keeps the native-currency value and never blocks or expires an alert merely because USD conversion is unavailable.

## Optional free-mint alerts

The free-mint watcher runs inside the watcher service and follows this flow:

1. Load only users whose personal free-mint setting is enabled.
2. Skip OpenSea polling entirely when no user has opted in.
3. Read the official `upcoming` drops calendar with complete cursor handling and fetch detailed stages for drops entering the configured one-hour window.
4. Persist every recognized public, GTD, or FCFS stage's raw base-unit price and currency address.
5. For a free stage, claim each `(user, stage, start time)` once before durably queueing the initial alert.
6. Compare later observations with the stored price and persist an event for only an exact `0 → positive` transition.
7. Re-read durable transition events and claim each `(user, stage, start time, price version)` once before queueing `MINT PRICE CHANGED`.
8. Resolve the payment token through OpenSea so the warning can show token decimals, symbol, and approximate USD value.
9. Display start/end times in GMT.

Use **Settings** or `/settings` to toggle both the initial free-mint and follow-up price-change alerts. Once either message is queued, Telegram delivery continues retrying even if the mint later starts and leaves the configured discovery window. Interrupted discovery claims recover after one minute. A transition is announced only after the watcher previously observed that exact stage as free; a stage first discovered as paid does not produce a misleading change alert. OpenSea's calendar is the source of truth for discovery; a creator publishing a self-serve drop does not necessarily guarantee calendar inclusion, so the bot cannot alert for a drop absent from that API.

The manual `/freemints` directory is independent of the alert preference. Its **Upcoming** and **Live now** buttons always run a new OpenSea calendar query, while **Refresh**, **Previous**, and **Next** refresh before rendering their page. Live results also fetch detailed drop supply so sold-out drops are removed from the list. This keeps the directory current without storing a stale local catalog. Automatic notifications announce future public, GTD, and FCFS free stages entering the configured one-hour window, once per user and stage.

## Railway deployment

Create two Railway services from the same repository and give both the same environment variables.

1. **Bot service**: set its Railway **Custom Start Command** to `npm run start:bot`.
2. **Watcher service**: set its Railway **Custom Start Command** to `npm run start:watcher`.
3. For wallet eligibility, add a public domain to the **bot service**, then set `OPENSEA_OAUTH_REDIRECT_URI` to `https://YOUR_BOT_DOMAIN/oauth/opensea/callback`. The path must match exactly, and the URL must be registered as an allowed redirect URI for the OpenSea OAuth client. The bot service listens on Railway's `PORT` and sends the result back to Telegram after the browser callback.

The package also exposes `npm start` as a bot-safe default so Nixpacks can always produce a valid build plan. The watcher still requires its service-specific `npm run start:watcher` override; otherwise it would start a second Telegram bot process.

Nixpacks installs dependencies once with `npm ci --include=dev`, then Railway runs `npm run build`. Keeping installation and compilation in separate phases avoids rebuilding against Railway's mounted `node_modules` cache. The explicit dev-dependency inclusion keeps TypeScript available while `NODE_ENV=production` is set. The bot service needs its Railway HTTP port available when eligibility is enabled; the watcher does not need a public domain. Configure restart-on-failure for both, and deploy exactly one watcher replica.

Do not set a dashboard **Custom Build Command** containing `npm ci`; leave it empty so `railway.toml` supplies `npm run build`. Start commands are intentionally absent from the repository configuration because Railway's config-as-code overrides dashboard settings and both services use the same repository. Set the two service-specific **Custom Start Command** values in the dashboard as described above.

After deployment, verify both services are running. A healthy bot service alone is not enough for automatic alerts.

## Adding another EVM chain

For wallet monitoring only, add the network to `MONITORING_CHAINS_JSON`; no code or migration is required. This intentionally does not allow OpenSea URLs to resolve to that network.

Adding a fourth OpenSea discovery network is a separate product change: extend `SupportedChainKey`, the static discovery configuration, explorer adapter support, the SQL `collections.chain` constraint, and chain-resolution tests. No OpenSea URL or Telegram input can directly supply an arbitrary RPC or explorer URL.

## Dev-wallet inference model

The application stores distinct relationships for contract creator, deployment initiator, owner, royalty receiver, mint proceeds receiver, withdrawal destination, treasury, and likely dev wallet. The default weights live in `src/blockchain/devAnalyzer.ts` and can be changed without modifying the analyzer.

The highest-scoring address is selected only at medium confidence or above. At low confidence, the bot explicitly says that a team wallet could not be identified and tracks the verified deployment transaction initiator as a fallback.

This is an on-chain heuristic, not identity verification. A wallet may belong to a factory, multisig, payment splitter, treasury contract, marketplace operator, or unrelated administrator. The bot never maps anonymous addresses to real-world people.

## Watcher behavior and limitations

- Polling is used for predictable recovery across RPC providers. A persisted per-chain cursor resumes after restarts, and RPC calls use exponential backoff.
- Only top-level transactions initiated by the watched address alert. An incoming transaction, including one that transfers tokens to the watched wallet, is ignored.
- Native transfers, common ERC-20 and NFT transfer selectors, common V2/V3/aggregator swap selectors, and bridge deposit/withdrawal selectors are categorized. The activity dashboard counts and filters sends, swaps, and bridges separately. Unknown calldata is safely labeled `Contract interaction`.
- Internal transfers emitted by a contract call are not fully decoded yet. Receipt/log decoding and protocol-specific swap/bridge registries are the next enrichment layer.
- Direct wallet mint detection follows standard ERC-721 and ERC-1155 zero-address mint events on every built-in tracking chain. Buy/sell detection covers canonical Seaport 1.5/1.6 settlements and paid NFT transfers through marketplace router/aggregator contracts. The indexed recovery path uses public Blockscout APIs for Ethereum and Robinhood and replays up to 24 hours after watcher startup. Unpaid direct transfers are intentionally excluded; unusual protocols that hide both their payment and settlement route can still require a dedicated adapter.
- Marketplace alerts identify NFT direction but do not yet calculate aggregate sale price or fees.
- The 90% rule measures native currency and standard ERC-20 amounts emitted from the dev wallet during recognized swaps. Non-standard tokens that omit ordinary `Transfer` logs cannot be measured reliably.
- Pre-block balance is deterministic and RPC-portable, but multiple outgoing transactions from the same wallet in one block share that same reference balance.
- CEX detection is only as complete as `CEX_ADDRESSES_JSON`; exchanges issue many account-specific deposit addresses and can rotate infrastructure.
- Bridge detection uses the maintained selector registry. A new/custom bridge method must be added before it can be labeled automatically.
- Floor alerts use OpenSea's collection stats API, not the rendered website, individual-token trait floors, or marketplace listings outside OpenSea's reported aggregate. A threshold is evaluated once per `PRICE_ALERT_POLL_INTERVAL_MS`, so a brief price crossing entirely between polls may not be observed. Currency-symbol changes are not compared across unlike currencies. USD figures are approximate snapshots calculated from OpenSea's current token quote; they can move with the market and gracefully disappear when a valid quote is unavailable.
- Automatic free-mint discovery and price-change detection cover public, GTD, and FCFS stages returned by OpenSea's official upcoming calendar while they remain in the configured one-hour window. The manual directory can also show later upcoming stages and currently active stages surfaced across OpenSea's calendar categories; live stages with `total_supply >= max_supply` are excluded as sold out. Zero price excludes gas; other private, allowlist, and creator-only stages are intentionally excluded unless OpenSea labels them GTD or FCFS. Approximate USD values depend on OpenSea's current token quote and can move after the alert.
- `/info` treats "minting soon" as a stage beginning within 12 hours. Its 24-hour price change is calculated from OpenSea's floor-price history; it is reported as unavailable when a complete 24-hour baseline does not exist. Owner attribution and related collections reflect OpenSea account data, not verified real-world identity.
- Creator-token research is conservative: ERC-20 has no on-chain "memecoin" flag, so the bot only reports direct deployments by the verified NFT deployment initiator that expose standard ERC-20 metadata and have a DEX Screener market. Factory-created tokens, tokens without a detected DEX pair, unsupported DEX Screener chains, or deployments beyond an explorer's bounded history window may be omitted. At most the 250 newest created contracts per chain are probed to keep an interactive Telegram request bounded. When an explorer or probe boundary is reached, the Telegram result explicitly warns that older deployments may exist.
- ERC-2981 probing uses token ID `0`; contracts that reject that ID may hide an otherwise valid royalty receiver.
- Common recipient getter names are deterministic when present, but arbitrary custom withdrawal logic cannot be inferred generically.
- One confirmation is the default. Increase `WATCHER_CONFIRMATIONS` for stronger reorg protection.
- Telegram delivery is at-least-once: every automatic alert is stored before its source event is finalized, failed sends retry with capped exponential backoff, and interrupted delivery claims recover after one minute. In the narrow case where Telegram accepts a message but the database confirmation repeatedly fails, recovery may send a duplicate rather than lose the alert.

## Tests

The test suite covers dashboard workflow descriptions and action grouping, fresh paginated upcoming/live free-mint views, short-page cursor continuation, consolidated active-tracking summaries and management paths, Telegram group-picker deep links, URL and address validation, collection research by URL and contract, owner/related-collection filtering, creator deployment-history parsing for Etherscan and Blockscout, ERC-20 and DEX-market creator-token filtering, empty-history omission, lossless Telegram message chunking for long creator histories, active/upcoming mint-versus-floor formatting, offer/volume/floor-history metrics, one-time floor-target parsing, upward/downward threshold crossing, live floor-currency USD quote refresh and formatting, safe tiny-value and unavailable-quote fallback formatting, OpenSea floor retrieval, OpenSea NFT-name and item-link enrichment, pending-delivery display, confirmed cancellation copy, successful notification queueing, failed-enqueue release behavior, durable Telegram delivery, retry backoff and stale-claim recovery, discovery versus monitoring chain mapping, stale watcher-cursor recovery, live subscription-change replay, periodic live-window reconciliation, direct-wallet live-scanner isolation, paced marketplace RPC log queries, provider-compatible targeted marketplace log batching, independent Blockscout recovery, marketplace-router purchase recognition, OpenSea upcoming free-mint filtering, public paid-stage observation, payment-token metadata, free-to-paid transition rules, GMT and USD alert formatting, cross-chain dev-wallet linkage, personal and group subscription deduplication, Telegram admin-role checks, personal and group alert fan-out, outgoing filtering, pre-block native and ERC-20 swap-balance reads, high-risk native-send/swap/bridge/CEX alerts, send/swap/bridge decoding, direct-wallet and group dashboard formatting, ERC-721/ERC-1155 mint and marketplace decoding, distinct NFT-minted alert formatting, and duplicate marketplace-alert prevention.

```bash
npm test
```

## Continuous integration

The workflow in `.github/workflows/ci.yml` runs on every push to `main` and on pull requests. It uses Node.js 22 and performs:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The workflow has read-only repository permissions, npm dependency caching, a 10-minute job timeout, and cancellation of superseded runs.

## Secrets and public repositories

The real `.env` file is ignored by Git and must never be committed. `.env.example` contains variable names and safe defaults only. Store production credentials in the deployment platform's environment-variable or secrets interface.

Treat `TELEGRAM_BOT_TOKEN`, `SUPABASE_SECRET_KEY`, the legacy `SUPABASE_SERVICE_ROLE_KEY`, `OPENSEA_API_KEY`, RPC URLs containing provider credentials, and explorer API keys as secrets. Rotate a credential immediately if it is ever committed or printed in a public log. GitHub Actions are pinned to immutable commit SHAs and run with read-only repository permissions.

## Security and privacy model

- The bot and watcher are backend-only processes. They do not expose an HTTP listener or accept inbound webhooks.
- Supabase is accessed only with a backend secret. All application tables use RLS, `anon` and `authenticated` have no table grants, and future public-schema objects default to no client access.
- Personal collection, wallet, activity, settings, active-tracking, and floor-alert management is restricted to a private Telegram chat. Group collection tracking has a separate path and rechecks the acting member's administrator status through Telegram.
- OpenSea slugs, contract addresses, and clickable OpenSea/DEX links are validated or constructed from canonical allowlisted hosts. External API and on-chain labels are flattened, length-limited, and stripped of embedded URLs and directional controls before display.
- Logs remove credential-bearing URLs, authorization values, known secret formats, and Telegram/chat identifiers. Failed Telegram delivery details are sanitized before being stored in Supabase.
- Stored data includes Telegram numeric IDs, public wallet/contract addresses, public transaction hashes and activity, tracking preferences, and queued Telegram message text. Delivered outbox rows are pruned after 30 days; active user and tracking records remain until they are removed from the database.

After pulling a migration that changes `supabase/migrations`, apply it before or alongside the matching application deployment:

```bash
npx supabase db push --linked
```

Railway deploys the Node.js services but does not automatically run Supabase migrations unless you explicitly configure a migration step.

## External API references

- [OpenSea: Get drops](https://docs.opensea.io/reference/get_drops)
- [OpenSea: Get a single collection](https://docs.opensea.io/reference/get_collection)
- [Project OpenSea: canonical Seaport deployments](https://github.com/ProjectOpenSea/seaport#deployments)
- [Etherscan v2: Contract creator and creation transaction](https://docs.etherscan.io/api-reference/endpoint/getcontractcreation)
- [Etherscan v2: Normal transactions by address](https://docs.etherscan.io/api-reference/endpoint/txlist)
- [Blockscout v2: Address info](https://docs.blockscout.com/api-reference/get-address-info)
- [Blockscout v2: Address transactions](https://docs.blockscout.com/api-reference/get-address-transactions)
- [DEX Screener: Token-pair API](https://docs.dexscreener.com/api/reference)
- [Robinhood Chain network configuration](https://docs.robinhood.com/chain/connecting/)
- [Supabase database security](https://supabase.com/docs/guides/database/secure-data)
- [Telegram Bot API: chat member statuses](https://core.telegram.org/bots/api#getchatmember)
