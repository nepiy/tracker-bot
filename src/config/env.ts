import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OPENSEA_API_KEY: z.string().min(1),
  ETHEREUM_RPC_URL: z.url(),
  BASE_RPC_URL: z.url(),
  ROBINHOOD_RPC_URL: z.url().default("https://rpc.mainnet.chain.robinhood.com"),
  ETHERSCAN_API_KEY: z.string().optional(),
  BLOCKSCOUT_API_KEY: z.string().optional(),
  WATCHER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(12_000),
  WATCHER_BOOTSTRAP_LOOKBACK_BLOCKS: z.coerce.number().int().min(0).default(10),
  WATCHER_CONFIRMATIONS: z.coerce.number().int().min(0).default(1),
  TELEGRAM_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(8),
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
