import { parseAbi, type Address } from "viem";
import type { ChainClient } from "./clients.js";
import type { ExplorerAdapter, ExplorerCreatedContract } from "../explorers/types.js";
import type { ChainConfig } from "../types/index.js";
import { safeDisplayText } from "../utils/display.js";

const erc20MetadataAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
const METADATA_BATCH_SIZE = 10;
const DEX_BATCH_SIZE = 30;
const MAX_CREATED_CONTRACT_PROBES = 250;

interface DexToken {
  address?: string;
  name?: string;
  symbol?: string;
}

interface DexPair {
  url?: string;
  baseToken?: DexToken;
  quoteToken?: DexToken;
  priceUsd?: string | null;
  liquidity?: { usd?: number | null } | null;
  marketCap?: number | null;
  fdv?: number | null;
}

export interface CreatorMarketToken {
  chainId: number;
  chainName: string;
  address: Address;
  name: string;
  symbol: string;
  createdAt: Date | null;
  explorerUrl: string;
  marketUrl: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
}

export interface ChainCreatorTokenResult {
  tokens: CreatorMarketToken[];
  complete: boolean;
}

interface Erc20Candidate {
  deployment: ExplorerCreatedContract;
  name: string;
  symbol: string;
}

async function readErc20Candidate(
  deployment: ExplorerCreatedContract,
  client: ChainClient,
): Promise<Erc20Candidate | null> {
  try {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      client.readContract({ address: deployment.address, abi: erc20MetadataAbi, functionName: "name" }),
      client.readContract({ address: deployment.address, abi: erc20MetadataAbi, functionName: "symbol" }),
      client.readContract({ address: deployment.address, abi: erc20MetadataAbi, functionName: "decimals" }),
      client.readContract({ address: deployment.address, abi: erc20MetadataAbi, functionName: "totalSupply" }),
    ]);
    const cleanName = safeDisplayText(name, 200, "");
    const cleanSymbol = safeDisplayText(symbol, 32, "");
    if (!cleanName || !cleanSymbol || decimals > 255 || totalSupply < 0n) return null;
    return { deployment, name: cleanName, symbol: cleanSymbol };
  } catch {
    return null;
  }
}

async function readErc20Candidates(
  deployments: ExplorerCreatedContract[],
  client: ChainClient,
): Promise<Erc20Candidate[]> {
  const candidates: Erc20Candidate[] = [];
  for (let index = 0; index < deployments.length; index += METADATA_BATCH_SIZE) {
    const batch = deployments.slice(index, index + METADATA_BATCH_SIZE);
    const resolved = await Promise.all(batch.map((deployment) => readErc20Candidate(deployment, client)));
    candidates.push(...resolved.filter((candidate): candidate is Erc20Candidate => candidate !== null));
  }
  return candidates;
}

function bestPairForToken(pairs: DexPair[], address: Address): DexPair | null {
  const normalized = address.toLowerCase();
  return pairs
    .filter((pair) => (
      pair.baseToken?.address?.toLowerCase() === normalized
      || pair.quoteToken?.address?.toLowerCase() === normalized
    ))
    .sort((left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0))[0] ?? null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function canonicalDexScreenerUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "dexscreener.com" && host !== "www.dexscreener.com")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function loadDexPairs(
  chainKey: string,
  candidates: Erc20Candidate[],
  fetcher: typeof fetch,
): Promise<{ pairs: Map<Address, DexPair>; complete: boolean }> {
  const pairsByToken = new Map<Address, DexPair>();
  let complete = true;
  for (let index = 0; index < candidates.length; index += DEX_BATCH_SIZE) {
    const batch = candidates.slice(index, index + DEX_BATCH_SIZE);
    const addresses = batch.map((candidate) => candidate.deployment.address).join(",");
    const response = await fetcher(
      `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chainKey)}/${addresses}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) {
      complete = false;
      continue;
    }
    const pairs = await response.json() as DexPair[];
    if (!Array.isArray(pairs)) {
      complete = false;
      continue;
    }
    for (const candidate of batch) {
      const pair = bestPairForToken(pairs, candidate.deployment.address);
      const marketUrl = canonicalDexScreenerUrl(pair?.url);
      if (pair && marketUrl) pairsByToken.set(candidate.deployment.address, { ...pair, url: marketUrl });
    }
  }
  return { pairs: pairsByToken, complete };
}

export async function findCreatorMarketTokensOnChain(
  deployer: Address,
  chain: ChainConfig,
  explorer: ExplorerAdapter,
  client: ChainClient,
  fetcher: typeof fetch = fetch,
): Promise<ChainCreatorTokenResult> {
  if (!explorer.getCreatedContracts) return { tokens: [], complete: false };
  const history = await explorer.getCreatedContracts(deployer);
  const deployments = history.contracts.slice(-MAX_CREATED_CONTRACT_PROBES);
  const candidates = await readErc20Candidates(deployments, client);
  const market = await loadDexPairs(chain.key, candidates, fetcher);
  const tokens = candidates.flatMap((candidate): CreatorMarketToken[] => {
    const pair = market.pairs.get(candidate.deployment.address);
    if (!pair?.url) return [];
    return [{
      chainId: chain.chainId,
      chainName: chain.name,
      address: candidate.deployment.address,
      name: candidate.name,
      symbol: candidate.symbol,
      createdAt: candidate.deployment.createdAt,
      explorerUrl: `${chain.explorerUrl}/address/${candidate.deployment.address}`,
      marketUrl: pair.url,
      priceUsd: finiteNumber(pair.priceUsd),
      liquidityUsd: finiteNumber(pair.liquidity?.usd),
      marketCapUsd: finiteNumber(pair.marketCap ?? pair.fdv),
    }];
  });
  return {
    tokens: tokens.sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0)),
    complete: history.complete && history.contracts.length <= MAX_CREATED_CONTRACT_PROBES && market.complete,
  };
}
