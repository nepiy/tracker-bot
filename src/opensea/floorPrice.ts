import { ExternalServiceError, UserFacingError } from "../utils/errors.js";

const OPEN_SEA_API = "https://api.opensea.io/api/v2";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,199}$/;

interface OpenSeaCollectionStatsResponse {
  total?: {
    floor_price?: number;
    floor_price_symbol?: string;
  };
}

export interface OpenSeaFloorPrice {
  amount: number;
  symbol: string;
}

export async function getOpenSeaFloorPrice(
  apiKey: string,
  slug: string,
  fetcher: typeof fetch = fetch,
): Promise<OpenSeaFloorPrice | null> {
  if (!SLUG_PATTERN.test(slug)) {
    throw new UserFacingError("That OpenSea collection slug is invalid.", "INVALID_SLUG");
  }
  const response = await fetcher(`${OPEN_SEA_API}/collections/${encodeURIComponent(slug)}/stats`, {
    headers: { accept: "application/json", "x-api-key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) {
    throw new ExternalServiceError("OpenSea rate limit reached", "opensea", true);
  }
  if (!response.ok) {
    throw new ExternalServiceError(
      `OpenSea returned HTTP ${response.status} while reading the collection floor`,
      "opensea",
      response.status >= 500,
    );
  }
  const stats = await response.json() as OpenSeaCollectionStatsResponse;
  const amount = stats.total?.floor_price;
  const symbol = stats.total?.floor_price_symbol?.trim();
  if (!Number.isFinite(amount) || amount! < 0 || !symbol) return null;
  return { amount: amount!, symbol };
}
