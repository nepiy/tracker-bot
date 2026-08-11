import { z } from "zod";
import type { AppEnv } from "./env.js";
import { normalizeAddress } from "../utils/address.js";
import type { ChainConfig } from "../types/index.js";

const extraChainSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string().min(1).max(100),
  rpcUrl: z.url(),
  explorerUrl: z.url(),
  nativeSymbol: z.string().min(1).max(12),
});

const cexAddressSchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string(),
  exchange: z.string().min(1).max(60),
});

function parseJson(value: string, setting: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${setting} must contain valid JSON`);
  }
}

export function getExtraMonitoringChains(env: AppEnv): ChainConfig[] {
  const entries = z.array(extraChainSchema).parse(parseJson(env.MONITORING_CHAINS_JSON ?? "[]", "MONITORING_CHAINS_JSON"));
  const seen = new Set<number>();
  return entries.map((entry) => {
    if (seen.has(entry.chainId)) throw new Error(`Duplicate monitoring chain ID: ${entry.chainId}`);
    seen.add(entry.chainId);
    return {
      key: `monitor-${entry.chainId}`,
      ...entry,
      openSeaIdentifiers: [],
      explorerApiUrl: entry.explorerUrl,
      explorerType: "blockscout",
    };
  });
}

export function getCexAddressBook(env: AppEnv): Map<string, string> {
  const entries = z.array(cexAddressSchema).parse(parseJson(env.CEX_ADDRESSES_JSON ?? "[]", "CEX_ADDRESSES_JSON"));
  const result = new Map<string, string>();
  for (const entry of entries) {
    const address = normalizeAddress(entry.address);
    result.set(`${entry.chainId}:${address}`, entry.exchange);
  }
  return result;
}
