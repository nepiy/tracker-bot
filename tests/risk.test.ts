import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { AppEnv } from "../src/config/env.js";
import { assessActivityRisk } from "../src/watcher/risk.js";
import { formatActivityAlert } from "../src/watcher/notifications.js";

const wallet = "0x0000000000000000000000000000000000000001" as Address;
const destination = "0x0000000000000000000000000000000000000002" as Address;
const env = {
  ETHEREUM_RPC_URL: "https://eth.example",
  BASE_RPC_URL: "https://base.example",
  ROBINHOOD_RPC_URL: "https://robinhood.example",
  MONITORING_CHAINS_JSON: "[]",
  CEX_ADDRESSES_JSON: JSON.stringify([{ chainId: 1, address: destination, exchange: "Binance" }]),
} as AppEnv;

describe("high-risk dev activity", () => {
  it("alerts only above 90% of the pre-block native balance", () => {
    const base = {
      chainId: 1,
      to: destination,
      decoded: { type: "native_transfer" as const, label: "Native transfer", metadata: {} },
    };
    expect(assessActivityRisk({ ...base, value: 91n, balanceBefore: 100n }, { ...env, CEX_ADDRESSES_JSON: "[]" }).highRisk).toBe(true);
    expect(assessActivityRisk({ ...base, value: 90n, balanceBefore: 100n }, { ...env, CEX_ADDRESSES_JSON: "[]" }).highRisk).toBe(false);
  });

  it("alerts for bridge activity and configured CEX destinations", () => {
    const bridge = assessActivityRisk({
      chainId: 1,
      to: destination,
      value: 0n,
      balanceBefore: null,
      decoded: { type: "bridge", label: "Bridge deposit", metadata: {} },
    }, env);
    expect(bridge.reasons).toContain("Bridge-out transaction detected");
    expect(bridge.reasons).toContain("Destination matches configured CEX: Binance");
  });

  it("places ALERT at the top of a high-risk Telegram notification", () => {
    const text = formatActivityAlert(
      { telegramId: 1, collectionName: "FishBroker", collectionId: "collection", chainId: 1 },
      {
        chainId: 1,
        wallet,
        to: destination,
        value: 2_917_000_000_000_000n,
        balanceBefore: 3_000_000_000_000_000n,
        hash: `0x${"3".repeat(64)}`,
        decoded: { type: "native_transfer", label: "Native token transfer", metadata: {} },
      },
      env,
      "2000",
    );
    expect(text.startsWith("🚨🚨 ALERT: HIGH-RISK DEV ACTIVITY 🚨🚨")).toBe(true);
    expect(text).toContain("configured CEX: Binance");
    expect(text).toContain("Value: 0.002917 ETH (≈ $5.83)");
  });
});
