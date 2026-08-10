import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppEnv } from "../config/env.js";

export function createDatabaseClient(env: AppEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "opensea-dev-wallet-tracker/1.0" } },
  });
}

export function assertDatabaseResult(error: { message: string } | null, operation: string): void {
  if (error) throw new Error(`Database ${operation} failed: ${error.message}`);
}
