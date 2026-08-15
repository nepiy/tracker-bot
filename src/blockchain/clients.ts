import { createPublicClient, defineChain, fallback, http } from "viem";
import { base, mainnet } from "viem/chains";
import type { AppEnv } from "../config/env.js";
import type { ChainConfig } from "../types/index.js";

const PUBLIC_ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

function createTransport(config: ChainConfig) {
  const primary = http(config.rpcUrl, { timeout: 15_000 });
  if (config.chainId !== 4663 || config.rpcUrl === PUBLIC_ROBINHOOD_RPC_URL) return primary;
  const secondary = http(PUBLIC_ROBINHOOD_RPC_URL, { timeout: 15_000 });
  return fallback([primary, secondary], { retryCount: 1, retryDelay: 250 });
}

export function createChainClient(config: ChainConfig) {
  const chain =
    config.chainId === 1
      ? mainnet
      : config.chainId === 8453
        ? base
        : defineChain({
            id: config.chainId,
            name: config.name,
            nativeCurrency: { name: "Ether", symbol: config.nativeSymbol, decimals: 18 },
            rpcUrls: { default: { http: [config.rpcUrl] } },
            blockExplorers: { default: { name: "Blockscout", url: config.explorerUrl } },
          });

  return createPublicClient({ chain, transport: createTransport(config) });
}

export type ChainClient = ReturnType<typeof createChainClient>;

export function createClients(configs: ChainConfig[]): Map<number, ChainClient> {
  return new Map(configs.map((config) => [config.chainId, createChainClient(config)]));
}

export function rpcUrlForChain(config: ChainConfig, _env: AppEnv): string {
  return config.rpcUrl;
}
