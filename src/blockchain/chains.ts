import type { AppEnv } from "../config/env.js";
import type { ChainConfig, SupportedChainKey } from "../types/index.js";
import { UserFacingError } from "../utils/errors.js";
import { getExtraMonitoringChains } from "../config/monitoring.js";

type DiscoveryChainConfig = ChainConfig & { key: SupportedChainKey };
type StaticChainConfig = Omit<DiscoveryChainConfig, "rpcUrl"> & { rpcEnvKey: keyof AppEnv };

export const BASE_CHAIN_ID = 8453;

const STATIC_CHAINS: Record<SupportedChainKey, StaticChainConfig> = {
  ethereum: {
    key: "ethereum",
    name: "Ethereum",
    chainId: 1,
    openSeaIdentifiers: ["ethereum", "eth"],
    rpcEnvKey: "ETHEREUM_RPC_URL",
    explorerUrl: "https://etherscan.io",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerType: "etherscan",
    nativeSymbol: "ETH",
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    openSeaIdentifiers: ["robinhood", "robinhood_chain", "robinhood-chain"],
    rpcEnvKey: "ROBINHOOD_RPC_URL",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    explorerApiUrl: "https://robinhoodchain.blockscout.com",
    explorerType: "blockscout",
    nativeSymbol: "ETH",
  },
};

export function getChains(env: AppEnv): Record<SupportedChainKey, DiscoveryChainConfig> {
  const materialize = (key: SupportedChainKey): DiscoveryChainConfig => {
    const { rpcEnvKey, ...chain } = STATIC_CHAINS[key];
    return { ...chain, rpcUrl: String(env[rpcEnvKey]) };
  };
  return {
    ethereum: materialize("ethereum"),
    robinhood: materialize("robinhood"),
  };
}

export function getMonitoringChains(env: AppEnv): ChainConfig[] {
  const discoveryChains = Object.values(getChains(env));
  const discoveryIds = new Set(discoveryChains.map((chain) => chain.chainId));
  // Ignore legacy Base entries instead of allowing an old Railway variable to
  // bring the watcher down after Base support has been removed.
  const extras = getExtraMonitoringChains(env).filter((chain) => chain.chainId !== BASE_CHAIN_ID);
  for (const chain of extras) {
    if (discoveryIds.has(chain.chainId)) {
      throw new Error(`Monitoring chain ID ${chain.chainId} duplicates a built-in chain`);
    }
    discoveryIds.add(chain.chainId);
  }
  return [...discoveryChains, ...extras];
}

export function resolveChainIdentifier(identifier: string, env: AppEnv): DiscoveryChainConfig {
  const normalized = identifier.toLowerCase();
  const chain = Object.values(getChains(env)).find((candidate) =>
    candidate.openSeaIdentifiers.includes(normalized),
  );
  if (!chain) {
    throw new UserFacingError(
      `The collection is on an unsupported chain (${identifier}).`,
      "UNSUPPORTED_CHAIN",
    );
  }
  return chain;
}

export function getChainById(chainId: number, env: AppEnv): ChainConfig {
  const chain = getMonitoringChains(env).find((candidate) => candidate.chainId === chainId);
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);
  return chain;
}
