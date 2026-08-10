import { describe, expect, it } from "vitest";
import { resolveChainIdentifier } from "../src/blockchain/chains.js";
import type { AppEnv } from "../src/config/env.js";

const env = {
  ETHEREUM_RPC_URL: "https://eth.example",
  BASE_RPC_URL: "https://base.example",
  ROBINHOOD_RPC_URL: "https://robinhood.example",
} as AppEnv;

describe("chain resolution", () => {
  it.each([
    ["ethereum", 1],
    ["base", 8453],
    ["robinhood_chain", 4663],
  ])("maps OpenSea chain %s to chain ID %s", (identifier, chainId) => {
    expect(resolveChainIdentifier(identifier, env).chainId).toBe(chainId);
  });

  it("rejects unsupported chains", () => {
    expect(() => resolveChainIdentifier("polygon", env)).toThrow("unsupported chain");
  });
});
