import type { Address } from "viem";
import { ExternalServiceError } from "../utils/errors.js";

const OPEN_SEA_API = "https://api.opensea.io/api/v2";

interface OpenSeaNftResponse {
  nft?: {
    name?: string | null;
    opensea_url?: string | null;
  };
}

export interface OpenSeaNftSummary {
  name: string;
  openSeaUrl: string;
}

export function openSeaAssetUrl(chain: string, contract: Address, tokenId: bigint): string {
  return `https://opensea.io/assets/${encodeURIComponent(chain)}/${contract}/${tokenId}`;
}

function canonicalOpenSeaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "opensea.io" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function getOpenSeaNftSummary(
  apiKey: string,
  chain: string,
  contract: Address,
  tokenId: bigint,
  fetcher: typeof fetch = fetch,
): Promise<OpenSeaNftSummary | null> {
  const response = await fetcher(
    `${OPEN_SEA_API}/chain/${encodeURIComponent(chain)}/contract/${contract}/nfts/${tokenId}`,
    {
      headers: { accept: "application/json", "x-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) return null;
  if (response.status === 429) {
    throw new ExternalServiceError("OpenSea rate limit reached", "opensea", true);
  }
  if (!response.ok) {
    throw new ExternalServiceError(
      `OpenSea returned HTTP ${response.status} while reading NFT metadata`,
      "opensea",
      response.status >= 500,
    );
  }

  const body = await response.json() as OpenSeaNftResponse;
  const name = body.nft?.name?.trim() || `NFT #${tokenId}`;
  const openSeaUrl = canonicalOpenSeaUrl(body.nft?.opensea_url)
    ?? openSeaAssetUrl(chain, contract, tokenId);
  return { name, openSeaUrl };
}
