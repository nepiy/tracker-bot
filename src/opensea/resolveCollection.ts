import type { AppEnv } from "../config/env.js";
import type { ResolvedCollection } from "../types/index.js";
import { normalizeAddress } from "../utils/address.js";
import { safeDisplayText } from "../utils/display.js";
import { ExternalServiceError, UserFacingError } from "../utils/errors.js";
import { resolveChainIdentifier } from "../blockchain/chains.js";
import { isOpenSeaSlug, parseOpenSeaUrl } from "./parseOpenSeaUrl.js";

interface OpenSeaContract {
  address: string;
  chain: string;
}

interface OpenSeaCollectionResponse {
  collection?: string;
  name?: string;
  contracts?: OpenSeaContract[];
}

export async function resolveOpenSeaCollection(
  url: string,
  env: AppEnv,
  fetcher: typeof fetch = fetch,
  preferredChainIds: readonly number[] = [],
): Promise<ResolvedCollection> {
  const slug = parseOpenSeaUrl(url);
  const response = await fetcher(
    `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`,
    {
      headers: { accept: "application/json", "x-api-key": env.OPENSEA_API_KEY },
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (response.status === 404) {
    throw new UserFacingError("I couldn't find that OpenSea collection.", "COLLECTION_NOT_FOUND");
  }
  if (response.status === 429) {
    throw new ExternalServiceError("OpenSea rate limit reached", "opensea", true);
  }
  if (!response.ok) {
    throw new ExternalServiceError(`OpenSea returned HTTP ${response.status}`, "opensea", response.status >= 500);
  }

  const data = (await response.json()) as OpenSeaCollectionResponse;
  if (!data.name || !Array.isArray(data.contracts) || data.contracts.length === 0) {
    throw new ExternalServiceError("OpenSea returned an incomplete collection response", "opensea", false);
  }
  const collectionName = safeDisplayText(data.name, 300, "Unnamed collection");

  const preferred = new Set(preferredChainIds);
  const contracts = [...data.contracts].sort((left, right) => {
    try {
      const leftChain = resolveChainIdentifier(left.chain, env).chainId;
      const rightChain = resolveChainIdentifier(right.chain, env).chainId;
      return Number(preferred.has(rightChain)) - Number(preferred.has(leftChain));
    } catch {
      return 0;
    }
  });
  for (const contract of contracts) {
    try {
      const chain = resolveChainIdentifier(contract.chain, env);
      return {
        name: collectionName,
        slug: data.collection && isOpenSeaSlug(data.collection) ? data.collection.toLowerCase() : slug,
        chain: chain.key,
        chainId: chain.chainId,
        contractAddress: normalizeAddress(contract.address),
      };
    } catch (error) {
      if (!(error instanceof UserFacingError && error.code === "UNSUPPORTED_CHAIN")) throw error;
    }
  }

  const available = safeDisplayText(data.contracts.map((contract) => contract.chain).join(", "), 200);
  throw new UserFacingError(
    `This collection has no contract on a supported chain. Found: ${available}.`,
    "UNSUPPORTED_CHAIN",
  );
}
