import { createPublicClient, defineChain, http } from "viem";
import { base, mainnet } from "viem/chains";
import type { AppEnv } from "../config/env.js";
import type { ChainConfig } from "../types/index.js";

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

  return createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 15_000 }) });
}

export type ChainClient = ReturnType<typeof createChainClient>;

export function createClients(configs: ChainConfig[]): Map<number, ChainClient> {
  return new Map(configs.map((config) => [config.chainId, createChainClient(config)]));
}

export function rpcUrlForChain(config: ChainConfig, _env: AppEnv): string {
  return config.rpcUrl;
}
