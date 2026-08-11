import { describe, expect, it } from "vitest";
import { isFreeToPaidTransition } from "../src/database/repositories/mintStagePrices.js";
import { formatPaidMintPrice } from "../src/watcher/notifications.js";

describe("mint price changes", () => {
  it("alerts only when a previously free stage becomes positively priced", () => {
    expect(isFreeToPaidTransition("0", "1")).toBe(true);
    expect(isFreeToPaidTransition("000", "10000")).toBe(true);
    expect(isFreeToPaidTransition("0", "0")).toBe(false);
    expect(isFreeToPaidTransition("100", "200")).toBe(false);
    expect(isFreeToPaidTransition("100", "0")).toBe(false);
  });

  it("formats very small USD values without rounding them to zero", () => {
    expect(formatPaidMintPrice(
      "1",
      "0x0000000000000000000000000000000000000001",
      { symbol: "USDC", decimals: 6, usdPrice: "1" },
    )).toBe("0.000001 USDC (≈ <$0.01)");
  });
});
