import "dotenv/config";
import { z } from "zod";

const jsonArrayString = z.string().refine((value) => {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}, "Must be a JSON array");

const httpEndpoint = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:")
    && !url.username
    && !url.password;
}, "Must be an HTTP(S) URL without embedded username/password credentials");

const optionalSecret = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  SUPABASE_URL: httpEndpoint,
  SUPABASE_SECRET_KEY: optionalSecret,
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
  OPENSEA_API_KEY: z.string().trim().min(1),
  ETHEREUM_RPC_URL: httpEndpoint,
  ROBINHOOD_RPC_URL: httpEndpoint.default("https://rpc.mainnet.chain.robinhood.com"),
  ETHERSCAN_API_KEY: optionalSecret,
  BLOCKSCOUT_API_KEY: optionalSecret,
  MONITORING_CHAINS_JSON: jsonArrayString.default("[]"),
  CEX_ADDRESSES_JSON: jsonArrayString.default("[]"),
  WATCHER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(12_000),
  WATCHER_BOOTSTRAP_LOOKBACK_BLOCKS: z.coerce.number().int().min(0).default(10),
  WATCHER_MAX_BACKLOG_BLOCKS: z.coerce.number().int().min(1).default(5_000),
  WATCHER_SCAN_BATCH_SIZE: z.coerce.number().int().min(1).max(2_000).default(250),
  WATCHER_BLOCK_FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(16),
  WATCHER_CONFIRMATIONS: z.coerce.number().int().min(0).default(1),
  WATCHER_LIVE_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(2_000),
  WATCHER_LIVE_LOOKBACK_BLOCKS: z.coerce.number().int().min(10).max(2_000).default(100),
  WATCHER_SUBSCRIPTION_REPLAY_BLOCKS: z.coerce.number().int().min(10).max(20_000).default(1_000),
  WATCHER_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(30_000),
  WATCHER_MARKETPLACE_LOG_QUERY_INTERVAL_MS: z.coerce.number().int().min(50).default(125),
  FREE_MINT_LOOKAHEAD_HOURS: z.coerce.number().int().min(1).max(24).default(1),
  FREE_MINT_POLL_INTERVAL_MS: z.coerce.number().int().min(60_000).default(600_000),
  PRICE_ALERT_POLL_INTERVAL_MS: z.coerce.number().int().min(30_000).default(60_000),
  TELEGRAM_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(8),
  TELEGRAM_GLOBAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(240),
  TELEGRAM_MAX_CONCURRENT_UPDATES: z.coerce.number().int().min(1).max(200).default(20),
}).superRefine((env, context) => {
  if (!env.SUPABASE_SECRET_KEY && !env.SUPABASE_SERVICE_ROLE_KEY) {
    context.addIssue({
      code: "custom",
      path: ["SUPABASE_SECRET_KEY"],
      message: "Set SUPABASE_SECRET_KEY (recommended) or SUPABASE_SERVICE_ROLE_KEY (legacy)",
    });
  }
  if (env.NODE_ENV !== "production") return;
  for (const field of ["SUPABASE_URL", "ETHEREUM_RPC_URL", "ROBINHOOD_RPC_URL"] as const) {
    if (new URL(env[field]).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Production endpoints must use HTTPS",
      });
    }
  }
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

export function getEnv(): AppEnv {
  cachedEnv ??= envSchema.parse(process.env);
  return cachedEnv;
}

export function resetEnvForTests(): void {
  cachedEnv = undefined;
}
