import type { AppEnv } from "../config/env.js";
import type { ChainConfig } from "../types/index.js";
import { ExternalServiceError } from "../utils/errors.js";
import { BlockscoutExplorer } from "./blockscout.js";
import { EtherscanExplorer } from "./etherscan.js";
import type { ExplorerAdapter } from "./types.js";

class FallbackExplorer implements ExplorerAdapter {
  constructor(private readonly adapters: ExplorerAdapter[]) {}

  async getContractDeployment(address: Parameters<ExplorerAdapter["getContractDeployment"]>[0]) {
    let lastError: unknown;
    for (const adapter of this.adapters) {
      try {
        return await adapter.getContractDeployment(address);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new ExternalServiceError("No explorer adapters are configured", "explorer", false);
  }

  async getCreatedContracts(address: Parameters<NonNullable<ExplorerAdapter["getCreatedContracts"]>>[0]) {
    let lastError: unknown;
    for (const adapter of this.adapters) {
      if (!adapter.getCreatedContracts) continue;
      try {
        return await adapter.getCreatedContracts(address);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new ExternalServiceError("No explorer history adapter is configured", "explorer", false);
  }
}

const BLOCKSCOUT_FALLBACKS: Partial<Record<number, string>> = {
  1: "https://eth.blockscout.com",
  8453: "https://base.blockscout.com",
};

export function createExplorer(chain: ChainConfig, env: AppEnv): ExplorerAdapter {
  if (chain.explorerType === "blockscout") {
    return new BlockscoutExplorer(chain, env.BLOCKSCOUT_API_KEY);
  }
  const adapters: ExplorerAdapter[] = [];
  if (env.ETHERSCAN_API_KEY) {
    adapters.push(new EtherscanExplorer(chain, env.ETHERSCAN_API_KEY));
  }
  const blockscoutUrl = BLOCKSCOUT_FALLBACKS[chain.chainId];
  if (blockscoutUrl) {
    adapters.push(
      new BlockscoutExplorer({ ...chain, explorerApiUrl: blockscoutUrl, explorerType: "blockscout" }),
    );
  }
  if (!adapters.length) {
    throw new ExternalServiceError("No contract explorer is configured for this chain", "explorer", false);
  }
  return new FallbackExplorer(adapters);
}
