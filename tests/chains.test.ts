import { describe, expect, it } from "vitest";
import {
  getMonitoringChains,
  getTrackingChainById,
  getTrackingChains,
  isTrackingChainId,
  resolveChainIdentifier,
} from "../src/blockchain/chains.js";
import type { AppEnv } from "../src/config/env.js";

const env = {
  ETHEREUM_RPC_URL: "https://eth.example",
  ROBINHOOD_RPC_URL: "https://robinhood.example",
} as AppEnv;

describe("chain resolution", () => {
  it.each([
    ["ethereum", 1],
    ["robinhood_chain", 4663],
  ])("maps OpenSea chain %s to chain ID %s", (identifier, chainId) => {
    expect(resolveChainIdentifier(identifier, env).chainId).toBe(chainId);
  });

  it("rejects unsupported chains", () => {
    expect(() => resolveChainIdentifier("polygon", env)).toThrow("unsupported chain");
    expect(() => resolveChainIdentifier("base", env)).toThrow("unsupported chain");
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

  it("ignores legacy Base entries in additional monitoring configuration", () => {
    const configured = {
      ...env,
      MONITORING_CHAINS_JSON: JSON.stringify([{
        chainId: 8453,
        name: "Base",
        rpcUrl: "https://base.example",
        explorerUrl: "https://basescan.org",
        nativeSymbol: "ETH",
      }]),
    } as AppEnv;
    expect(getMonitoringChains(configured).map((chain) => chain.chainId)).not.toContain(8453);
  });

  it("keeps Ethereum discoverable while limiting activity tracking to Robinhood", () => {
    expect(resolveChainIdentifier("ethereum", env).chainId).toBe(1);
    expect(getTrackingChains(env).map((chain) => chain.chainId)).toEqual([4663]);
    expect(isTrackingChainId(4663)).toBe(true);
    expect(isTrackingChainId(1)).toBe(false);
    expect(() => getTrackingChainById(1, env)).toThrow("only on Robinhood Chain");
  });
});
