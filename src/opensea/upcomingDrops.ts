import { ExternalServiceError } from "../utils/errors.js";

const OPEN_SEA_API = "https://api.opensea.io/api/v2";
const MAX_DROP_PAGES = 10;
const DROP_PAGE_SIZE = 100;

interface OpenSeaDropStageResponse {
  uuid?: string;
  stage_type?: string;
  label?: string;
  price?: string;
  price_currency_address?: string;
  start_time?: string;
  end_time?: string;
}

interface OpenSeaDropSummaryResponse {
  collection_slug?: string;
  collection_name?: string;
  chain?: string;
  opensea_url?: string;
  next_stage?: OpenSeaDropStageResponse | null;
}

interface OpenSeaDropsResponse {
  drops?: OpenSeaDropSummaryResponse[];
  next?: string | null;
}

interface OpenSeaDropDetailsResponse extends OpenSeaDropSummaryResponse {
  stages?: OpenSeaDropStageResponse[];
}

export interface UpcomingMintStage {
  slug: string;
  name: string;
  chain: string;
  openSeaUrl: string;
  stageId: string;
  stageType: string;
  stageLabel: string;
  price: string;
  currencyAddress: string;
  startsAt: Date;
  endsAt: Date | null;
}

export type UpcomingFreeMint = UpcomingMintStage;

interface OpenSeaTokenResponse {
  symbol?: string;
  decimals?: number;
  usd_price?: string;
  usdPrice?: string;
}

export interface OpenSeaTokenDetails {
  symbol: string;
  decimals: number;
  usdPrice: string | null;
}

async function fetchOpenSeaJson<T>(
  path: string,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<T> {
  const response = await fetcher(`${OPEN_SEA_API}${path}`, {
    headers: { accept: "application/json", "x-api-key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) {
    throw new ExternalServiceError("OpenSea rate limit reached", "opensea", true);
  }
  if (!response.ok) {
    throw new ExternalServiceError(
      `OpenSea returned HTTP ${response.status} while reading drops`,
      "opensea",
      response.status >= 500,
    );
  }
  return await response.json() as T;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startsWithin(stage: OpenSeaDropStageResponse | null | undefined, now: Date, cutoff: Date): boolean {
  const startsAt = parseDate(stage?.start_time);
  return Boolean(startsAt && startsAt > now && startsAt <= cutoff);
}

function isPublicMintStage(stage: OpenSeaDropStageResponse): boolean {
  return stage.stage_type === "public_sale"
    && typeof stage.price === "string"
    && /^\d+$/.test(stage.price)
    && typeof stage.price_currency_address === "string"
    && /^0x[0-9a-fA-F]{40}$/.test(stage.price_currency_address);
}

export function isFreeMintPrice(price: string): boolean {
  return /^0+$/.test(price);
}

async function inChunks<T, R>(
  values: T[],
  size: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += size) {
    results.push(...await Promise.all(values.slice(index, index + size).map(mapper)));
  }
  return results;
}

export async function findUpcomingMintStages(
  apiKey: string,
  now = new Date(),
  windowHours = 12,
  fetcher: typeof fetch = fetch,
): Promise<UpcomingMintStage[]> {
  const cutoff = new Date(now.getTime() + windowHours * 60 * 60 * 1_000);
  const candidates = new Map<string, OpenSeaDropSummaryResponse>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_DROP_PAGES; page += 1) {
    const query = new URLSearchParams({ type: "upcoming", limit: String(DROP_PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    const response = await fetchOpenSeaJson<OpenSeaDropsResponse>(`/drops?${query}`, apiKey, fetcher);
    const drops = Array.isArray(response.drops) ? response.drops : [];

    for (const drop of drops) {
      if (drop.collection_slug && startsWithin(drop.next_stage, now, cutoff)) {
        candidates.set(drop.collection_slug, drop);
      }
    }

    cursor = typeof response.next === "string" && response.next ? response.next : null;
    if (!cursor || drops.length < DROP_PAGE_SIZE) break;
    if (drops.length && drops.every((drop) => {
      const start = parseDate(drop.next_stage?.start_time);
      return start !== null && start > cutoff;
    })) break;
  }

  const details = await inChunks([...candidates.entries()], 5, async ([slug, summary]) => {
    const detail = await fetchOpenSeaJson<OpenSeaDropDetailsResponse>(
      `/drops/${encodeURIComponent(slug)}`,
      apiKey,
      fetcher,
    );
    return { slug, summary, detail };
  });

  const unique = new Map<string, UpcomingMintStage>();
  for (const { slug, summary, detail } of details) {
    const stages = Array.isArray(detail.stages) ? detail.stages : [];
    for (const stage of stages) {
      const startsAt = parseDate(stage.start_time);
      if (!stage.uuid || !startsAt || !startsWithin(stage, now, cutoff) || !isPublicMintStage(stage)) continue;
      const endsAt = parseDate(stage.end_time);
      const mint: UpcomingMintStage = {
        slug,
        name: detail.collection_name ?? summary.collection_name ?? slug,
        chain: detail.chain ?? summary.chain ?? "unknown",
        openSeaUrl: detail.opensea_url ?? summary.opensea_url ?? `https://opensea.io/collection/${slug}`,
        stageId: stage.uuid,
        stageType: stage.stage_type ?? "unknown",
        stageLabel: stage.label?.trim() || "Mint stage",
        price: stage.price!,
        currencyAddress: stage.price_currency_address!.toLowerCase(),
        startsAt,
        endsAt,
      };
      unique.set(`${mint.stageId}:${mint.startsAt.toISOString()}`, mint);
    }
  }

  return [...unique.values()].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
}

export async function findUpcomingFreeMints(
  apiKey: string,
  now = new Date(),
  windowHours = 12,
  fetcher: typeof fetch = fetch,
): Promise<UpcomingFreeMint[]> {
  const stages = await findUpcomingMintStages(apiKey, now, windowHours, fetcher);
  return stages.filter((stage) => isFreeMintPrice(stage.price));
}

export async function getOpenSeaTokenDetails(
  apiKey: string,
  chain: string,
  address: string,
  fetcher: typeof fetch = fetch,
): Promise<OpenSeaTokenDetails> {
  const token = await fetchOpenSeaJson<OpenSeaTokenResponse>(
    `/chain/${encodeURIComponent(chain)}/token/${encodeURIComponent(address)}`,
    apiKey,
    fetcher,
  );
  if (!token.symbol || !Number.isInteger(token.decimals) || token.decimals! < 0 || token.decimals! > 255) {
    throw new ExternalServiceError("OpenSea returned incomplete payment-token metadata", "opensea", false);
  }
  const usdPrice = token.usd_price ?? token.usdPrice;
  return {
    symbol: token.symbol,
    decimals: token.decimals!,
    usdPrice: typeof usdPrice === "string" && usdPrice ? usdPrice : null,
  };
}
