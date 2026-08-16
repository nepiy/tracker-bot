import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotContext } from "../src/bot/context.js";
import { requirePrivateTrackingChat } from "../src/bot/chatAccess.js";
import { rateLimit } from "../src/bot/middleware/rateLimit.js";
import { canonicalDexScreenerUrl } from "../src/blockchain/creatorTokens.js";
import { getEnv, resetEnvForTests } from "../src/config/env.js";
import { getExtraMonitoringChains } from "../src/config/monitoring.js";
import { openSeaCollectionUrl } from "../src/opensea/parseOpenSeaUrl.js";
import { redactSensitiveText, safeErrorMessage, sanitizeLogValue } from "../src/utils/sanitize.js";
import { safeDisplayText } from "../src/utils/display.js";

const originalEnv = { ...process.env };

function setValidEnvironment(): void {
  Object.assign(process.env, {
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyzABCDEFGH",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_example_backend_key",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OPENSEA_API_KEY: "opensea-test-key",
    ETHEREUM_RPC_URL: "https://ethereum.example/rpc-key",
    ROBINHOOD_RPC_URL: "https://robinhood.example/rpc-key",
    MONITORING_CHAINS_JSON: "[]",
    CEX_ADDRESSES_JSON: "[]",
  });
}

beforeEach(() => {
  setValidEnvironment();
  resetEnvForTests();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetEnvForTests();
});

describe("secret and privacy redaction", () => {
  it("removes credential-bearing URLs, tokens, auth headers, and private Telegram identifiers", () => {
    const telegramToken = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFGH";
    const value = sanitizeLogValue({
      err: `RPC failed at https://provider.example/${telegramToken}?apiKey=secret`,
      authorization: "Bearer private-token",
      telegramId: 123456789,
      nested: { rpcUrl: "https://provider.example/private-key" },
    });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("provider.example");
    expect(serialized).not.toContain(telegramToken);
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("123456789");
    expect(serialized).toContain("[REDACTED");
  });

  it("sanitizes retry errors before persistence", () => {
    const message = safeErrorMessage(new Error("POST https://api.telegram.org/bot123456789:abcdefghijklmnopqrstuvwxyzABCDEFGH/sendMessage failed"));
    expect(message).toBe("POST [REDACTED_URL] failed");
    expect(redactSensitiveText("Authorization: Bearer abc123")).not.toContain("abc123");
  });
});

describe("configuration trust boundaries", () => {
  it("accepts the modern Supabase backend key when the legacy key is blank", () => {
    expect(getEnv().SUPABASE_SECRET_KEY).toBe("sb_secret_example_backend_key");
    expect(getEnv().SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it("rejects embedded URL credentials and insecure production endpoints", () => {
    process.env.ETHEREUM_RPC_URL = "https://user:password@ethereum.example";
    resetEnvForTests();
    expect(() => getEnv()).toThrow("without embedded username/password");

    setValidEnvironment();
    process.env.NODE_ENV = "production";
    process.env.ROBINHOOD_RPC_URL = "http://robinhood.example";
    resetEnvForTests();
    expect(() => getEnv()).toThrow("Production endpoints must use HTTPS");
  });

  it("requires HTTPS for production-only extra monitoring chains", () => {
    process.env.NODE_ENV = "production";
    process.env.MONITORING_CHAINS_JSON = JSON.stringify([{
      chainId: 10,
      name: "Optimism",
      rpcUrl: "http://rpc.example",
      explorerUrl: "https://explorer.example",
      nativeSymbol: "ETH",
    }]);
    resetEnvForTests();
    const env = getEnv();
    expect(() => getExtraMonitoringChains(env)).toThrow("rpcUrl must use HTTPS");
  });
});

describe("outbound link allowlists", () => {
  it("flattens misleading external labels and removes embedded links", () => {
    expect(safeDisplayText("Real collection\n🚨 ALERT https://evil.example\u202emoc.live", 80))
      .toBe("Real collection 🚨 ALERT [link removed]");
  });

  it("constructs canonical OpenSea collection links from validated slugs", () => {
    expect(openSeaCollectionUrl("FishBroker")).toBe("https://opensea.io/collection/fishbroker");
    expect(() => openSeaCollectionUrl("../phishing")).toThrow("slug is invalid");
  });

  it("accepts only HTTPS DEX Screener links", () => {
    expect(canonicalDexScreenerUrl("https://dexscreener.com/ethereum/pair")).toBe("https://dexscreener.com/ethereum/pair");
    expect(canonicalDexScreenerUrl("http://dexscreener.com/ethereum/pair")).toBeNull();
    expect(canonicalDexScreenerUrl("https://dexscreener.com.evil.example/pair")).toBeNull();
  });
});

describe("Telegram personal-data boundaries", () => {
  it("caps accepted traffic across distinct Telegram users", async () => {
    const middleware = rateLimit(10, 10, 2);
    const next = vi.fn(async () => undefined);
    const replies = vi.fn(async () => undefined);
    for (const id of [1, 2, 3]) {
      await middleware({ chat: { id, type: "private" }, from: { id }, reply: replies } as unknown as BotContext, next);
    }
    expect(next).toHaveBeenCalledTimes(2);
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("caps simultaneously executing Telegram handlers", async () => {
    let releaseFirst!: () => void;
    const firstHandler = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const middleware = rateLimit(10, 10, 100, 1);
    const replies = vi.fn(async () => undefined);
    const first = middleware(
      { chat: { id: 1, type: "private" }, from: { id: 1 }, reply: replies } as unknown as BotContext,
      vi.fn(async () => firstHandler),
    );
    await Promise.resolve();
    const secondNext = vi.fn(async () => undefined);
    await middleware(
      { chat: { id: 2, type: "private" }, from: { id: 2 }, reply: replies } as unknown as BotContext,
      secondNext,
    );
    expect(secondNext).not.toHaveBeenCalled();
    expect(replies).toHaveBeenCalledWith(expect.stringContaining("bot is busy"));
    releaseFirst();
    await first;
  });

  it("blocks personal tracking dashboards inside groups", async () => {
    const answerCallbackQuery = vi.fn(async () => undefined);
    const context = {
      chat: { id: -1001, type: "supergroup" },
      callbackQuery: { id: "callback" },
      answerCallbackQuery,
      reply: vi.fn(async () => undefined),
    } as unknown as BotContext;
    await expect(requirePrivateTrackingChat(context)).resolves.toBe(false);
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
  });

  it("allows the same personal dashboards in private chat", async () => {
    const context = {
      chat: { id: 1, type: "private" },
      answerCallbackQuery: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    } as unknown as BotContext;
    await expect(requirePrivateTrackingChat(context)).resolves.toBe(true);
    expect(context.reply).not.toHaveBeenCalled();
  });
});
