# OpenSea Dev Wallet Tracker Bot

A production-oriented Telegram bot that resolves an NFT collection from an OpenSea URL, separates verified deployment facts from inferred team-wallet signals, and alerts subscribers only when the selected wallet initiates an outgoing transaction.

Initially supported EVM networks:

- Ethereum (`1`)
- Base (`8453`)
- Robinhood Chain (`4663`)

The project uses TypeScript, Node.js 22+, grammY, viem, Supabase/PostgreSQL, the OpenSea API, Etherscan v2, and Blockscout v2.

## What it does

Send the bot a URL such as `https://opensea.io/collection/fishbroker`. It will:

1. Validate the URL and extract the slug without fetching an arbitrary host.
2. Resolve the collection name, chain, and contract through OpenSea's v2 API.
3. Resolve the direct contract creator and creation transaction through the configured explorer.
4. Read the creation transaction to distinguish a factory contract from its external initiator.
5. inspect deterministic contract signals such as `owner()`, ERC-2981 `royaltyInfo()`, common primary-sale recipient methods, withdrawal destinations, and treasury methods.
6. Score candidates and clearly label the selected wallet as inferred.
7. Persist one subscription per Telegram user and collection.
8. Monitor each unique wallet once, store outgoing activity, and fan alerts out to every active subscriber.

Incoming transactions do not alert. A transaction only qualifies when its top-level `from` address equals a currently watched address.

## Architecture

```text
Telegram bot process
  └─ OpenSea resolver
      └─ chain adapter
          ├─ explorer deployment adapter
          ├─ viem RPC client
          └─ dev-wallet analyzer
              └─ Supabase repositories

Watcher process (one runner per chain)
  └─ deduplicated active wallets
      └─ restart-safe block cursor
          └─ outgoing transaction filter
              ├─ activity decoder + storage
              └─ Telegram notification fan-out
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
- Production RPC endpoints for Ethereum, Base, and Robinhood Chain
- An Etherscan API key is recommended for Ethereum and Base contract-creation lookups

The public Robinhood RPC in `.env.example` is rate-limited. Use a production provider for deployment.

## Telegram BotFather setup

1. Open `@BotFather` in Telegram.
2. Run `/newbot` and follow the prompts.
3. Copy the token into `TELEGRAM_BOT_TOKEN`.
4. Optionally use `/setcommands` with:

   ```text
   start - Start the bot
   help - Show help
   track - Track an OpenSea collection
   list - List active subscriptions
   stop - Stop tracking a collection
   activity - Show recent outgoing activity
   ```

Do not put the token in source control or Railway build logs.

## OpenSea API key

Create an API key using OpenSea's current developer flow and set `OPENSEA_API_KEY`. The implementation calls:

```text
GET https://api.opensea.io/api/v2/collections/{slug}
X-API-KEY: ...
```

It does not scrape OpenSea HTML.

## Supabase setup

1. Create a Supabase project.
2. Copy the project URL and service-role/secret key into `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Apply the migration with the included CLI:

   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push --linked
   npx supabase migration list --linked
   ```

Alternatively, run the SQL migration in the Supabase SQL editor.

Every application table has RLS enabled. `anon` and `authenticated` have no table grants or policies because both processes are trusted backend services using the service-role key. Never expose that key to a browser or Telegram user.

The schema contains:

- `users`
- `collections`
- `wallets`
- `collection_wallets`
- `subscriptions`
- `processed_transactions`
- `wallet_activity`
- `chain_sync_state`

Wallets use a unique `(chain_id, address)` key, subscriptions use a unique `(user_id, collection_id)` key, and processed transactions use `(chain_id, tx_hash)` for deduplication.

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
| `SUPABASE_SERVICE_ROLE_KEY` | Backend-only database key |
| `OPENSEA_API_KEY` | OpenSea v2 API key |
| `ETHEREUM_RPC_URL` | Ethereum JSON-RPC endpoint |
| `BASE_RPC_URL` | Base JSON-RPC endpoint |
| `ROBINHOOD_RPC_URL` | Robinhood Chain JSON-RPC endpoint |
| `ETHERSCAN_API_KEY` | Recommended Etherscan v2 key for Ethereum and Base; public Blockscout instances are used as fallback |

Optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BLOCKSCOUT_API_KEY` | unset | Bearer token for a protected Blockscout instance |
| `WATCHER_POLL_INTERVAL_MS` | `12000` | Delay after a successful chain scan |
| `WATCHER_BOOTSTRAP_LOOKBACK_BLOCKS` | `10` | Blocks scanned when a chain cursor is first created |
| `WATCHER_CONFIRMATIONS` | `1` | Head blocks held back to reduce reorg risk |
| `TELEGRAM_RATE_LIMIT_PER_MINUTE` | `8` | Per-user request limit per process |
| `LOG_LEVEL` | `info` | Pino structured-log level |

Environment values are validated at startup. Secrets are redacted from structured logs.

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

Production commands:

```bash
npm run start:bot
npm run start:watcher
```

Only run one bot long-polling process for a Telegram token. Multiple watcher replicas are not currently supported because transaction claiming and activity insertion are separate database operations.

## Telegram commands

- `/start` and `/help`: setup and command help
- `/track <OpenSea URL>`: analyze and subscribe
- Paste an OpenSea collection URL directly: same behavior as `/track`
- `/list`: active subscriptions for the current Telegram user
- `/stop`: inline buttons that deactivate only that user's subscription
- `/activity`: recent stored outgoing activity for one active collection

Stopping one subscription never disables another user's subscription. The watcher derives its deduplicated wallet set from all active subscriptions.

## Railway deployment

Create two Railway services from the same repository and give both the same environment variables.

1. **Bot service**: use `npm run start:bot`. The included `railway.toml` and `nixpacks.toml` default to this command.
2. **Watcher service**: override the Railway start command with `npm run start:watcher`.

Both services run `npm ci && npm run build` during deployment. Neither needs an HTTP port or public domain. Configure restart-on-failure for both, and deploy exactly one watcher replica.

## Adding another EVM chain

1. Add the chain key to `SupportedChainKey` in `src/types/index.ts`.
2. Add one entry in `src/blockchain/chains.ts`, including OpenSea identifiers, chain ID, RPC environment key, explorer URL/type, and native symbol.
3. Add the RPC variable to `src/config/env.ts` and `.env.example`.
4. If viem does not export the chain, define it in `src/blockchain/clients.ts` as Robinhood Chain is defined.
5. Reuse `EtherscanExplorer` or `BlockscoutExplorer`; add a new adapter only when the explorer API is genuinely different.
6. Extend the SQL `collections.chain` check and add chain-resolution tests.

No OpenSea URL or user input can select an arbitrary RPC or explorer URL.

## Dev-wallet inference model

The application stores distinct relationships for contract creator, deployment initiator, owner, royalty receiver, mint proceeds receiver, withdrawal destination, treasury, and likely dev wallet. The default weights live in `src/blockchain/devAnalyzer.ts` and can be changed without modifying the analyzer.

The highest-scoring address is selected only at medium confidence or above. At low confidence, the bot explicitly says that a team wallet could not be identified and tracks the verified deployment transaction initiator as a fallback.

This is an on-chain heuristic, not identity verification. A wallet may belong to a factory, multisig, payment splitter, treasury contract, marketplace operator, or unrelated administrator. The bot never maps anonymous addresses to real-world people.

## Watcher behavior and limitations

- Polling is used for predictable recovery across RPC providers. A persisted per-chain cursor resumes after restarts, and RPC calls use exponential backoff.
- Only top-level transactions initiated by the watched address alert. An incoming transaction, including one that transfers tokens to the watched wallet, is ignored.
- Native transfers, common ERC-20 and NFT transfer selectors, several common swap selectors, and known bridge selectors are categorized. Unknown calldata is safely labeled `Contract interaction`.
- Internal transfers emitted by a contract call are not fully decoded yet. Receipt/log decoding and protocol-specific swap/bridge registries are the next enrichment layer.
- ERC-2981 probing uses token ID `0`; contracts that reject that ID may hide an otherwise valid royalty receiver.
- Common recipient getter names are deterministic when present, but arbitrary custom withdrawal logic cannot be inferred generically.
- One confirmation is the default. Increase `WATCHER_CONFIRMATIONS` for stronger reorg protection.
- Failed Telegram sends are logged, but there is no durable notification outbox yet. Database activity remains available through `/activity`.

## Tests

The test suite uses mocked external dependencies and covers URL validation, address normalization, chain mapping, evidence scoring, weak-confidence fallback, factory deployment handling, subscription deduplication, outgoing filtering, incoming ignoring, activity decoding, and processed-transaction deduplication.

```bash
npm test
```

## External API references

- [OpenSea: Get a single collection](https://docs.opensea.io/reference/get_collection)
- [Etherscan v2: Contract creator and creation transaction](https://docs.etherscan.io/api-reference/endpoint/getcontractcreation)
- [Blockscout v2: Address info](https://docs.blockscout.com/api-reference/get-address-info)
- [Robinhood Chain network configuration](https://docs.robinhood.com/chain/connecting/)
- [Supabase database security](https://supabase.com/docs/guides/database/secure-data)
