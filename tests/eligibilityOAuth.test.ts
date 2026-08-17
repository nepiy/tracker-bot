import { describe, expect, it, vi } from "vitest";
import { OpenSeaOAuth } from "@opensea/sdk";
import type { AppEnv } from "../src/config/env.js";
import { EligibilityService } from "../src/services/eligibility.js";

vi.mock("../src/opensea/eligibility.js", () => ({
  findEligibleAllowlistStages: vi.fn(async () => ({
    eligibleStages: [],
    scannedDrops: 0,
  })),
}));

const wallet = "0x0000000000000000000000000000000000000001";

function env(redirectUri?: string): AppEnv {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    OPENSEA_API_KEY: "opensea-api-key",
    OPENSEA_OAUTH_CLIENT_ID: "public-client",
    OPENSEA_OAUTH_REDIRECT_URI: redirectUri,
    ETHEREUM_RPC_URL: "https://ethereum.example/rpc",
    ROBINHOOD_RPC_URL: "https://robinhood.example/rpc",
    ETHERSCAN_API_KEY: undefined,
    BLOCKSCOUT_API_KEY: undefined,
    MONITORING_CHAINS_JSON: "[]",
    CEX_ADDRESSES_JSON: "[]",
    WATCHER_POLL_INTERVAL_MS: 12_000,
    WATCHER_BOOTSTRAP_LOOKBACK_BLOCKS: 10,
    WATCHER_MAX_BACKLOG_BLOCKS: 5_000,
    WATCHER_SCAN_BATCH_SIZE: 250,
    WATCHER_BLOCK_FETCH_CONCURRENCY: 16,
    WATCHER_CONFIRMATIONS: 1,
    WATCHER_LIVE_POLL_INTERVAL_MS: 2_000,
    WATCHER_LIVE_LOOKBACK_BLOCKS: 100,
    WATCHER_SUBSCRIPTION_REPLAY_BLOCKS: 1_000,
    WATCHER_RECONCILE_INTERVAL_MS: 30_000,
    WATCHER_MARKETPLACE_LOG_QUERY_INTERVAL_MS: 125,
    FREE_MINT_LOOKAHEAD_HOURS: 1,
    FREE_MINT_POLL_INTERVAL_MS: 600_000,
    PRICE_ALERT_POLL_INTERVAL_MS: 60_000,
    TELEGRAM_RATE_LIMIT_PER_MINUTE: 8,
    TELEGRAM_GLOBAL_RATE_LIMIT_PER_MINUTE: 240,
    TELEGRAM_MAX_CONCURRENT_UPDATES: 20,
  };
}

function jwtWithWallet(address: string): string {
  const payload = Buffer.from(JSON.stringify({ wallet: address })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("OpenSea OAuth eligibility flow", () => {
  it("requires a configured callback before starting browser authorization", async () => {
    await expect(new EligibilityService(env()).start(123, wallet)).rejects.toMatchObject({
      code: "eligibility_redirect_not_configured",
    });
  });

  it("accepts one callback, exchanges the PKCE code, and matches the wallet claim", async () => {
    const createAuthorizationRequest = vi.spyOn(OpenSeaOAuth.prototype, "createAuthorizationRequest")
      .mockResolvedValue({
        url: "https://auth.opensea.io/oauth/v2/authorize?state=oauth-state",
        codeVerifier: "pkce-verifier",
        state: "oauth-state",
      });
    const exchangeCode = vi.spyOn(OpenSeaOAuth.prototype, "exchangeCode")
      .mockResolvedValue({
        accessToken: jwtWithWallet(wallet),
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() + 60_000),
        scopes: ["read:eligibility"],
        scopeSource: "authorization_server",
      });
    const revoke = vi.spyOn(OpenSeaOAuth.prototype, "revoke").mockResolvedValue(undefined);

    try {
      const service = new EligibilityService(env("https://bot.example/oauth/opensea/callback"));
      const session = await service.start(123, wallet);
      expect(session.authorizationUrl).toContain("state=oauth-state");
      expect(service.handleCallback(new URL("https://bot.example/oauth/opensea/callback?state=oauth-state&code=one-time-code")))
        .toMatchObject({ accepted: true, statusCode: 200 });
      await expect(session.result).resolves.toMatchObject({
        requestedAddress: wallet,
        authenticatedAddress: wallet,
        scannedDrops: 0,
      });
      expect(createAuthorizationRequest).toHaveBeenCalledWith({
        redirectUri: "https://bot.example/oauth/opensea/callback",
        scopes: ["read:eligibility"],
      });
      expect(exchangeCode).toHaveBeenCalledWith({
        code: "one-time-code",
        codeVerifier: "pkce-verifier",
        redirectUri: "https://bot.example/oauth/opensea/callback",
      });
      expect(revoke).toHaveBeenCalledWith("refresh-token");
      expect(service.handleCallback(new URL("https://bot.example/oauth/opensea/callback?state=oauth-state&code=replay")))
        .toMatchObject({ accepted: false, statusCode: 400 });
    } finally {
      createAuthorizationRequest.mockRestore();
      exchangeCode.mockRestore();
      revoke.mockRestore();
    }
  });

  it("returns a safe error for callbacks without a known state", () => {
    const service = new EligibilityService(env("https://bot.example/oauth/opensea/callback"));
    expect(service.handleCallback(new URL("https://bot.example/oauth/opensea/callback?code=unknown")))
      .toEqual({
        accepted: false,
        statusCode: 400,
        message: "Missing OAuth state. Return to Telegram and start again.",
      });
  });
});
