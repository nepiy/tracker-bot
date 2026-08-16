import { ExternalServiceError } from "../utils/errors.js";
import { safeDisplayText } from "../utils/display.js";
import { isOpenSeaSlug, openSeaCollectionUrl } from "./parseOpenSeaUrl.js";

const OPEN_SEA_API = "https://api.opensea.io/api/v2";
const MAX_DROP_PAGES = 10;
const DROP_PAGE_SIZE = 100;
const FEATURED_FALLBACK_MAX_DROPS = 50;

export interface OpenSeaDropStageResponse {
  uuid?: string;
  stage_type?: string;
  label?: string;
  price?: string;
  price_currency_address?: string;
  start_time?: string;
  end_time?: string;
}

export interface OpenSeaDropSummaryResponse {
  collection_slug?: string;
  collection_name?: string;
  chain?: string;
  opensea_url?: string;
  is_minting?: boolean;
  active_stage?: OpenSeaDropStageResponse | null;
  next_stage?: OpenSeaDropStageResponse | null;
  total_supply?: number | string | null;
  max_supply?: number | string | null;
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

export interface EligibilityDropStage {
  stageId: string;
  stageType: string;
  stageLabel: string;
  price: string;
  currencyAddress: string;
  startsAt: Date;
  endsAt: Date | null;
}

export interface EligibilityDropCandidate {
  slug: string;
  name: string;
  chain: string;
  openSeaUrl: string;
  isMinting: boolean;
  stages: EligibilityDropStage[];
}

export type UpcomingFreeMint = UpcomingMintStage;
export type FreeMintDirectoryView = "upcoming" | "live";

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
  return Boolean(startsAt && startsAt >= now && startsAt <= cutoff);
}

function normalizeStageText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * OpenSea's API uses `public_sale` for the general public stage, while drops
 * surfaced in the UI as GTD/FCFS are commonly represented as allowlist or
 * signed stages with the access name in `label`. Keep those useful public
 * access phases while excluding creator/team/private stages.
 */
function isTrackableMintStage(stage: OpenSeaDropStageResponse): boolean {
  const stageType = normalizeStageText(stage.stage_type);
  if (stageType === "public sale" || stageType === "public") return true;
  const stageText = normalizeStageText(`${stage.stage_type ?? ""} ${stage.label ?? ""}`);
  const guaranteedOrFirstCome = /\b(?:gtd|guaranteed|fcfs|first come first served|first come first serve)\b/.test(stageText);
  return guaranteedOrFirstCome;
}

function isValidMintStage(stage: OpenSeaDropStageResponse): boolean {
  return isTrackableMintStage(stage)
    && typeof stage.price === "string"
    && /^\d+$/.test(stage.price.trim())
    && typeof stage.price_currency_address === "string"
    && /^0x[0-9a-fA-F]{40}$/.test(stage.price_currency_address);
}

function stageToMint(
  summary: OpenSeaDropSummaryResponse,
  stage: OpenSeaDropStageResponse,
): UpcomingMintStage | null {
  const slug = summary.collection_slug;
  const startsAt = parseDate(stage.start_time);
  if (
    !slug
    || !isOpenSeaSlug(slug)
    || !stage.uuid
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(stage.uuid)
    || !startsAt
    || !isValidMintStage(stage)
  ) return null;
  return {
    slug: slug.toLowerCase(),
    name: safeDisplayText(summary.collection_name, 300, slug),
    chain: summary.chain ?? "unknown",
    openSeaUrl: openSeaCollectionUrl(slug),
    stageId: stage.uuid,
    stageType: safeDisplayText(stage.stage_type, 100, "unknown"),
    stageLabel: safeDisplayText(stage.label, 200, "Mint stage"),
    price: stage.price!,
    currencyAddress: stage.price_currency_address!.toLowerCase(),
    startsAt,
    endsAt: parseDate(stage.end_time),
  };
}

async function fetchDropCalendar(
  apiKey: string,
  type: "featured" | "upcoming" | "recently_minted",
  fetcher: typeof fetch,
  maxPages = MAX_DROP_PAGES,
): Promise<OpenSeaDropSummaryResponse[]> {
  const results: OpenSeaDropSummaryResponse[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({
      type,
      limit: String(DROP_PAGE_SIZE),
    });
    if (cursor) query.set("cursor", cursor);
    const response = await fetchOpenSeaJson<OpenSeaDropsResponse>(`/drops?${query}`, apiKey, fetcher);
    results.push(...(Array.isArray(response.drops) ? response.drops : []));
    cursor = typeof response.next === "string" && response.next ? response.next : null;
    // OpenSea can return fewer than the requested limit after post-fetch filtering,
    // so only the cursor—not the page length—can prove pagination is complete.
    if (!cursor) break;
  }
  return results;
}

function stageToEligibilityStage(stage: OpenSeaDropStageResponse): EligibilityDropStage | null {
  const startsAt = parseDate(stage.start_time);
  if (
    !stage.uuid
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(stage.uuid)
    || !startsAt
    || typeof stage.price !== "string"
    || !/^\d+$/.test(stage.price.trim())
    || typeof stage.price_currency_address !== "string"
    || !/^0x[0-9a-fA-F]{40}$/.test(stage.price_currency_address)
  ) return null;
  return {
    stageId: stage.uuid,
    stageType: safeDisplayText(stage.stage_type, 100, "unknown"),
    stageLabel: safeDisplayText(stage.label, 200, "Mint stage"),
    price: stage.price.trim(),
    currencyAddress: stage.price_currency_address.toLowerCase(),
    startsAt,
    endsAt: parseDate(stage.end_time),
  };
}

function isStageInEligibilityWindow(
  stage: EligibilityDropStage,
  isMinting: boolean,
  now: Date,
  cutoff: Date,
): boolean {
  const active = isMinting && stage.startsAt <= now && (!stage.endsAt || stage.endsAt > now);
  const upcoming = stage.startsAt >= now && stage.startsAt <= cutoff;
  return active || upcoming;
}

const ELIGIBILITY_CALENDAR_PAGES = 1;
const MAX_ELIGIBILITY_DROP_CANDIDATES = 24;

/**
 * Collects a bounded, fresh set of active or soon-to-start drops for the
 * wallet eligibility checker. The bound keeps one check below OpenSea's free
 * API rate limit while still covering the first page of each calendar.
 */
export async function findEligibilityDropCandidates(
  apiKey: string,
  now = new Date(),
  windowHours = 24,
  fetcher: typeof fetch = fetch,
): Promise<EligibilityDropCandidate[]> {
  const cutoff = new Date(now.getTime() + windowHours * 60 * 60 * 1_000);
  const pages = await Promise.all([
    fetchDropCalendar(apiKey, "upcoming", fetcher, ELIGIBILITY_CALENDAR_PAGES),
    fetchDropCalendar(apiKey, "featured", fetcher, ELIGIBILITY_CALENDAR_PAGES),
    fetchDropCalendar(apiKey, "recently_minted", fetcher, ELIGIBILITY_CALENDAR_PAGES),
  ]);
  const summaries = new Map<string, OpenSeaDropSummaryResponse>();
  for (const summary of pages.flat()) {
    const slug = summary.collection_slug?.trim().toLowerCase();
    if (!slug || !isOpenSeaSlug(slug)) continue;
    const existing = summaries.get(slug);
    if (!existing || summary.is_minting === true || existing.is_minting !== true) {
      summaries.set(slug, { ...summary, collection_slug: slug });
    }
  }

  const candidates = [...summaries.values()]
    .map((summary) => {
      const summaryStages = [summary.active_stage, summary.next_stage]
        .flatMap((stage) => stage ? [stageToEligibilityStage(stage)] : [])
        .filter((stage): stage is EligibilityDropStage => Boolean(stage));
      const stages = summaryStages.filter((stage) =>
        isStageInEligibilityWindow(stage, summary.is_minting === true, now, cutoff));
      // A newly listed or currently minting drop can omit summary stages until
      // its detail endpoint is indexed. Keep stage-less summaries as bounded
      // candidates so the detail request can discover the live/allowlist stage.
      const inWindow = stages.length > 0 || summaryStages.length === 0;
      return { summary, stages, inWindow };
    })
    .filter(({ inWindow }) => inWindow)
    .sort((left, right) => {
      const leftStart = left.stages.length
        ? Math.min(...left.stages.map((stage) => stage.startsAt.getTime()))
        : cutoff.getTime() + 1;
      const rightStart = right.stages.length
        ? Math.min(...right.stages.map((stage) => stage.startsAt.getTime()))
        : cutoff.getTime() + 1;
      return leftStart - rightStart;
    })
    .slice(0, MAX_ELIGIBILITY_DROP_CANDIDATES);

  // Calendar summaries expose only active/next stages. Fetch details for the
  // bounded candidate set so allowlist stages that are not the next public
  // stage can still be matched against the eligibility response.
  const details = await inChunks(candidates, 4, async ({ summary }) => {
    const slug = summary.collection_slug!;
    try {
      return await fetchOpenSeaJson<OpenSeaDropDetailsResponse>(
        `/drops/${encodeURIComponent(slug)}`,
        apiKey,
        fetcher,
      );
    } catch {
      return null;
    }
  });

  return candidates.flatMap(({ summary, stages }, index) => {
    const detail = details[index];
    const allStages = (Array.isArray(detail?.stages) ? detail.stages : [])
      .map(stageToEligibilityStage)
      .filter((stage): stage is EligibilityDropStage => Boolean(stage))
      .filter((stage) => isStageInEligibilityWindow(stage, detail?.is_minting ?? summary.is_minting === true, now, cutoff));
    const merged = new Map<string, EligibilityDropStage>();
    for (const stage of [...stages, ...allStages]) merged.set(stage.stageId, stage);
    if (!merged.size) return [];
    return [{
      slug: summary.collection_slug!,
      name: safeDisplayText(detail?.collection_name ?? summary.collection_name, 300, summary.collection_slug!),
      chain: detail?.chain ?? summary.chain ?? "unknown",
      openSeaUrl: openSeaCollectionUrl(summary.collection_slug!),
      isMinting: detail?.is_minting ?? summary.is_minting === true,
      stages: [...merged.values()].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime()),
    }];
  });
}

/**
 * Reads a fresh snapshot of public, GTD, and FCFS zero-price stages from OpenSea's drop calendar.
 * Upcoming uses the calendar's next stage and falls back to detailed stages from featured drops
 * when OpenSea's upcoming page is empty or omits the next stage. Live combines all calendar
 * categories and requires OpenSea to report that the stage is currently minting and has supply remaining.
 */
export async function findFreeMintDirectory(
  apiKey: string,
  view: FreeMintDirectoryView,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<UpcomingFreeMint[]> {
  const calendarTypes = view === "upcoming"
    ? (["upcoming"] as const)
    : (["featured", "upcoming", "recently_minted"] as const);
  const pages = await Promise.all(calendarTypes.map((type) => fetchDropCalendar(apiKey, type, fetcher)));
  const unique = new Map<string, UpcomingFreeMint>();
  const liveCandidates = new Map<string, UpcomingFreeMint>();
  const upcomingDetailCandidates = new Map<string, OpenSeaDropSummaryResponse>();

  for (const summary of pages.flat()) {
    const stage = view === "upcoming" ? summary.next_stage : summary.active_stage;
    const mint = stage ? stageToMint(summary, stage) : null;
    const isUpcoming = Boolean(mint && mint.startsAt > now);
    if (view === "upcoming") {
      // OpenSea's calendar summary can omit next_stage for drops that are still
      // featured, even though the detailed drop contains future stages. Keep a
      // bounded fallback set so those newly listed mints are not lost.
      if (
        summary.collection_slug
        && ((
          !summary.next_stage
          && summary.is_minting !== true
        ) || (Boolean(summary.next_stage) && (!mint || !isUpcoming)))
      ) {
        upcomingDetailCandidates.set(summary.collection_slug.toLowerCase(), summary);
      }
      if (!mint || !isFreeMintPrice(mint.price) || !isUpcoming) continue;
      unique.set(`${mint.slug}:${mint.stageId}:${mint.startsAt.toISOString()}`, mint);
      continue;
    }
    if (!mint || !isFreeMintPrice(mint.price)) continue;
    const isLive = summary.is_minting === true
      && mint.startsAt <= now
      && (!mint.endsAt || mint.endsAt > now);
    if (view === "live" && isLive && !isSoldOut(summary)) {
      liveCandidates.set(`${mint.slug}:${mint.stageId}:${mint.startsAt.toISOString()}`, mint);
    }
  }

  if (view === "upcoming") {
    // The documented upcoming calendar is occasionally empty while OpenSea's
    // featured calendar already contains the same newly listed drops. Query it
    // only as a fallback to avoid multiplying API traffic during normal polls.
    if (!pages[0]?.length || !unique.size) {
      const featured = await fetchDropCalendar(apiKey, "featured", fetcher);
      for (const summary of featured.slice(0, FEATURED_FALLBACK_MAX_DROPS)) {
        if (summary.collection_slug) {
          upcomingDetailCandidates.set(summary.collection_slug.toLowerCase(), summary);
        }
      }
    }
    if (upcomingDetailCandidates.size) {
      const details = await inChunks([...upcomingDetailCandidates.entries()], 5, async ([slug, summary]) => ({
        slug,
        summary,
        detail: await fetchOpenSeaJson<OpenSeaDropDetailsResponse>(
          `/drops/${encodeURIComponent(slug)}`,
          apiKey,
          fetcher,
        ),
      }));
      for (const { slug, summary, detail } of details) {
        const stages = Array.isArray(detail.stages) ? detail.stages : [];
        for (const stage of stages) {
          const enrichedSummary: OpenSeaDropSummaryResponse = { ...summary, collection_slug: slug };
          if (detail.collection_name) enrichedSummary.collection_name = detail.collection_name;
          if (detail.chain) enrichedSummary.chain = detail.chain;
          const mint = stageToMint(enrichedSummary, stage);
          if (!mint || mint.startsAt <= now || !isFreeMintPrice(mint.price)) continue;
          unique.set(`${mint.slug}:${mint.stageId}:${mint.startsAt.toISOString()}`, mint);
        }
      }
    }
  }

  if (view === "live" && liveCandidates.size) {
    const details = await inChunks([...liveCandidates.values()], 5, async (mint) => ({
      mint,
      detail: await fetchOpenSeaJson<OpenSeaDropDetailsResponse>(
        `/drops/${encodeURIComponent(mint.slug)}`,
        apiKey,
        fetcher,
      ),
    }));
    for (const { mint, detail } of details) {
      if (!isSoldOut(detail)) {
        unique.set(
          `${mint.slug}:${mint.stageId}:${mint.startsAt.toISOString()}`,
          mint,
        );
      }
    }
  }

  return [...unique.values()].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
}

export function isFreeMintPrice(price: string): boolean {
  return /^0+$/.test(price.trim());
}

function parseSupply(value: number | string | null | undefined): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function isSoldOut(drop: OpenSeaDropSummaryResponse): boolean {
  const totalSupply = parseSupply(drop.total_supply);
  const maxSupply = parseSupply(drop.max_supply);
  return maxSupply !== null && maxSupply > 0n && totalSupply !== null && totalSupply >= maxSupply;
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
  windowHours = 1,
  fetcher: typeof fetch = fetch,
): Promise<UpcomingMintStage[]> {
  const cutoff = new Date(now.getTime() + windowHours * 60 * 60 * 1_000);
  const candidates = new Map<string, OpenSeaDropSummaryResponse>();
  const drops = await fetchDropCalendar(apiKey, "upcoming", fetcher);
  for (const drop of drops) {
    if (drop.collection_slug && (!drop.next_stage || startsWithin(drop.next_stage, now, cutoff))) {
      candidates.set(drop.collection_slug.toLowerCase(), drop);
    }
  }

  // OpenSea has returned an empty upcoming page for newly listed drops while
  // exposing them in the featured calendar. Fall back to that calendar when
  // it yields no usable candidates, then inspect the detailed stage list.
  if (!candidates.size) {
    const featured = await fetchDropCalendar(apiKey, "featured", fetcher);
    for (const drop of featured.slice(0, FEATURED_FALLBACK_MAX_DROPS)) {
      if (
        drop.collection_slug
        && (!drop.next_stage || startsWithin(drop.next_stage, now, cutoff))
      ) {
        candidates.set(drop.collection_slug.toLowerCase(), drop);
      }
    }
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
      if (!stage.uuid || !startsAt || !startsWithin(stage, now, cutoff)) continue;
      const enrichedSummary: OpenSeaDropSummaryResponse = { ...summary, collection_slug: slug };
      if (detail.collection_name) enrichedSummary.collection_name = detail.collection_name;
      if (detail.chain) enrichedSummary.chain = detail.chain;
      const mint = stageToMint(enrichedSummary, stage);
      if (!mint) continue;
      unique.set(`${mint.slug}:${mint.stageId}:${mint.startsAt.toISOString()}`, mint);
    }
  }

  return [...unique.values()].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
}

export async function findUpcomingFreeMints(
  apiKey: string,
  now = new Date(),
  windowHours = 1,
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
    symbol: safeDisplayText(token.symbol, 20, "TOKEN"),
    decimals: token.decimals!,
    usdPrice: typeof usdPrice === "string" && usdPrice ? usdPrice : null,
  };
}
