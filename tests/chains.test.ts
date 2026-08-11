import { describe, expect, it } from "vitest";
import { getMonitoringChains, resolveChainIdentifier } from "../src/blockchain/chains.js";
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

  it("adds configured EVM monitoring chains without expanding OpenSea discovery", () => {
    const configured = {
      ...env,
      MONITORING_CHAINS_JSON: JSON.stringify([{
        chainId: 42161,
        name: "Arbitrum One",
        rpcUrl: "https://arb.example",
        explorerUrl: "https://arbiscan.io",
        nativeSymbol: "ETH",
      }]),
    } as AppEnv;
    expect(getMonitoringChains(configured).map((chain) => chain.chainId)).toContain(42161);
    expect(() => resolveChainIdentifier("arbitrum", configured)).toThrow("unsupported chain");
  });
});
