import { formatUnits, isAddress } from "viem";
import { normalizeAddress } from "../utils/address.js";
import { ExternalServiceError, UserFacingError } from "../utils/errors.js";
import {
  findOpenSeaUrl,
  isOpenSeaSlug,
  openSeaCollectionUrl,
  parseOpenSeaUrl,
} from "./parseOpenSeaUrl.js";
import { getOpenSeaTokenDetails, isFreeMintPrice, type OpenSeaTokenDetails } from "./upcomingDrops.js";
import { safeDisplayText } from "../utils/display.js";

const OPEN_SEA_API = "https://api.opensea.io/api/v2";
const CONTRACT_LOOKUP_CHAINS = ["ethereum", "robinhood"] as const;
const MINT_SOON_WINDOW_MS = 12 * 60 * 60 * 1_000;

interface OpenSeaContract {
  address?: string;
  chain?: string;
  collection?: string;
}

interface OpenSeaCurrency {
  symbol?: string;
  address?: string;
  chain?: string;
  decimals?: number;
  usd_price?: string;
}

interface OpenSeaCollectionResponse {
  collection?: string;
  name?: string;
  owner?: string;
  opensea_url?: string;
  contracts?: OpenSeaContract[];
  pricing_currencies?: Record<string, OpenSeaCurrency>;
}

interface OpenSeaStatsResponse {
  total?: {
    floor_price?: number;
    floor_price_symbol?: string;
  };
  intervals?: Array<{
    interval?: string;
    volume?: number;
  }>;
}

interface OpenSeaOffersResponse {
  offers?: Array<{
    price?: {
      currency?: string;
      decimals?: number;
      value?: string;
    };
  }>;
}

interface OpenSeaDropStageResponse {
  uuid?: string;
  stage_type?: string;
  label?: string;
  price?: string;
  price_currency_address?: string;
  start_time?: string;
  end_time?: string;
  max_per_wallet?: number | string | null;
}

interface OpenSeaDropResponse {
  is_minting?: boolean;
  active_stage?: OpenSeaDropStageResponse | null;
  next_stage?: OpenSeaDropStageResponse | null;
  stages?: OpenSeaDropStageResponse[];
  total_supply?: number | string | null;
  max_supply?: number | string | null;
}

interface OpenSeaFloorPricesResponse {
  floor_prices?: Array<{
    time?: number;
    token_unit?: number;
    chain?: string;
  }>;
}

interface OpenSeaAccountResponse {
  username?: string | null;
  ens_name?: string | null;
}

interface OpenSeaCollectionsResponse {
  collections?: OpenSeaCollectionResponse[];
}

export interface CollectionAmount {
  amount: string;
  symbol: string;
  approximateUsd: number | null;
}

export interface CollectionMintInfo {
  status: "active" | "upcoming";
  label: string;
  stageType: string;
  price: string | null;
  currencyAddress: string | null;
  token: OpenSeaTokenDetails | null;
  startsAt: Date | null;
  endsAt: Date | null;
  maxPerWallet: string | null;
  totalSupply: string | null;
  maxSupply: string | null;
}

export interface RelatedCollection {
  name: string;
  openSeaUrl: string;
}

export interface CollectionInfo {
  slug: string;
  name: string;
  openSeaUrl: string;
  chain: string;
  contractAddress: string;
  ownerAddress: string | null;
  ownerUsername: string | null;
  ownerEnsName: string | null;
  mint: CollectionMintInfo | null;
  floorPrice: number | null;
  floorPriceSymbol: string | null;
  floorPriceCurrencyAddress: string | null;
  floorPriceUsdRate: string | null;
  topOffer: CollectionAmount | null;
  volume24h: number | null;
  priceChange24hPercent: number | null;
  otherCollections: RelatedCollection[];
}

async function fetchOpenSeaJson<T>(
  path: string,
  apiKey: string,
  fetcher: typeof fetch,
  allowNotFound = false,
): Promise<T | null> {
  const response = await fetcher(`${OPEN_SEA_API}${path}`, {
    headers: { accept: "application/json", "x-api-key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404 && allowNotFound) return null;
  if (response.status === 429) {
    throw new ExternalServiceError("OpenSea rate limit reached", "opensea", true);
  }
  if (!response.ok) {
    throw new ExternalServiceError(
      `OpenSea returned HTTP ${response.status} while reading collection information`,
      "opensea",
      response.status >= 500,
    );
  }
  return await response.json() as T;
}

async function optional<T>(request: Promise<T | null>): Promise<T | null> {
  try {
    return await request;
  } catch {
    return null;
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isActiveStage(stage: OpenSeaDropStageResponse, now: Date): boolean {
  const startsAt = parseDate(stage.start_time);
  const endsAt = parseDate(stage.end_time);
  return startsAt !== null && startsAt <= now && (!endsAt || endsAt > now);
}

function selectMintStage(
  drop: OpenSeaDropResponse | null,
  now: Date,
): { status: "active" | "upcoming"; stage: OpenSeaDropStageResponse } | null {
  if (!drop) return null;
  const stages = Array.isArray(drop.stages) ? drop.stages : [];
  const active = drop.active_stage
    ?? (drop.is_minting === true ? stages.find((stage) => isActiveStage(stage, now)) : undefined);
  if (active && (drop.is_minting === true || isActiveStage(active, now))) {
    return { status: "active", stage: active };
  }

  const future = [drop.next_stage, ...stages]
    .filter((stage): stage is OpenSeaDropStageResponse => Boolean(stage))
    .map((stage) => ({ stage, startsAt: parseDate(stage.start_time) }))
    .filter((candidate): candidate is { stage: OpenSeaDropStageResponse; startsAt: Date } => (
      candidate.startsAt !== null
      && candidate.startsAt > now
      && candidate.startsAt.getTime() <= now.getTime() + MINT_SOON_WINDOW_MS
    ))
    .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime())[0];
  return future ? { status: "upcoming", stage: future.stage } : null;
}

function allCurrencies(collection: OpenSeaCollectionResponse): OpenSeaCurrency[] {
  return Object.values(collection.pricing_currencies ?? {}).filter(Boolean);
}

function tokenFromCollection(
  collection: OpenSeaCollectionResponse,
  currencyAddress: string,
): OpenSeaTokenDetails | null {
  const normalized = currencyAddress.toLowerCase();
  const currency = allCurrencies(collection).find((candidate) => candidate.address?.toLowerCase() === normalized);
  if (!currency?.symbol || !Number.isInteger(currency.decimals)) return null;
  return {
    symbol: safeDisplayText(currency.symbol, 20, "TOKEN"),
    decimals: currency.decimals!,
    usdPrice: typeof currency.usd_price === "string" && currency.usd_price ? currency.usd_price : null,
  };
}

function topOffer(
  offers: OpenSeaOffersResponse | null,
  collection: OpenSeaCollectionResponse,
): CollectionAmount | null {
  const price = offers?.offers?.[0]?.price;
  if (!price?.currency || !Number.isInteger(price.decimals) || !price.value || !/^\d+$/.test(price.value)) return null;
  const amount = formatUnits(BigInt(price.value), price.decimals!);
  const rate = allCurrencies(collection).find((currency) => currency.symbol === price.currency)?.usd_price;
  const approximateUsd = Number(amount) * Number(rate);
  return {
    amount,
    symbol: safeDisplayText(price.currency, 20, "TOKEN"),
    approximateUsd: Number.isFinite(approximateUsd) && approximateUsd >= 0 ? approximateUsd : null,
  };
}

function floorPriceChange(
  response: OpenSeaFloorPricesResponse | null,
  chain: string,
  now: Date,
): number | null {
  const allPoints = (response?.floor_prices ?? [])
    .filter((point): point is { time: number; token_unit: number; chain?: string } => (
      Number.isFinite(point.time) && Number.isFinite(point.token_unit)
    ));
  const chainPoints = allPoints.filter((point) => !point.chain || point.chain === chain);
  const points = (chainPoints.length ? chainPoints : allPoints)
    .filter((point) => point.time <= now.getTime() / 1_000 + 300)
    .sort((left, right) => left.time - right.time);
  const latest = points.at(-1);
  const cutoff = now.getTime() / 1_000 - 24 * 60 * 60;
  const baseline = points.filter((point) => point.time <= cutoff).at(-1);
  if (!latest || !baseline || baseline.token_unit <= 0) return null;
  return ((latest.token_unit - baseline.token_unit) / baseline.token_unit) * 100;
}

function selectContract(
  collection: OpenSeaCollectionResponse,
  preferred?: OpenSeaContract,
): OpenSeaContract | null {
  if (preferred?.address && preferred.chain) return preferred;
  const contracts = Array.isArray(collection.contracts) ? collection.contracts : [];
  return contracts.find((contract) => contract.address && contract.chain) ?? null;
}

async function resolveInput(
  input: string,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<{ slug: string; contract?: OpenSeaContract }> {
  const trimmed = input.trim();
  if (isAddress(trimmed, { strict: false })) {
    const address = normalizeAddress(trimmed);
    const matches = await Promise.allSettled(CONTRACT_LOOKUP_CHAINS.map(async (chain) => {
      const contract = await fetchOpenSeaJson<OpenSeaContract>(
        `/chain/${chain}/contract/${address}`,
        apiKey,
        fetcher,
        true,
      );
      return contract?.collection && isOpenSeaSlug(contract.collection)
        ? { ...contract, collection: contract.collection.toLowerCase(), address: contract.address ?? address, chain }
        : null;
    }));
    const contract = matches
      .filter((match) => match.status === "fulfilled")
      .map((match) => match.value)
      .find((match) => Boolean(match?.collection));
    if (!contract?.collection) {
      const failedRequest = matches.find((match) => match.status === "rejected");
      if (failedRequest?.status === "rejected") throw failedRequest.reason;
      throw new UserFacingError(
        "OpenSea could not find that contract on Ethereum or Robinhood Chain.",
        "COLLECTION_CONTRACT_NOT_FOUND",
      );
    }
    return { slug: contract.collection, contract };
  }

  const url = findOpenSeaUrl(trimmed) ?? trimmed;
  return { slug: parseOpenSeaUrl(url) };
}

async function loadOwnerCollections(
  ownerAddress: string | null,
  currentSlug: string,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<{
  username: string | null;
  ensName: string | null;
  collections: RelatedCollection[];
}> {
  if (!ownerAddress) return { username: null, ensName: null, collections: [] };
  const account = await optional(fetchOpenSeaJson<OpenSeaAccountResponse>(
    `/accounts/resolve/${encodeURIComponent(ownerAddress)}`,
    apiKey,
    fetcher,
    true,
  ));
  const rawUsername = account?.username?.trim() || null;
  const username = rawUsername ? safeDisplayText(rawUsername, 100, "") || null : null;
  const ensName = account?.ens_name ? safeDisplayText(account.ens_name, 255, "") || null : null;
  if (!rawUsername) return { username, ensName, collections: [] };

  const query = new URLSearchParams({ creator_username: rawUsername, limit: "20" });
  const response = await optional(fetchOpenSeaJson<OpenSeaCollectionsResponse>(
    `/collections?${query}`,
    apiKey,
    fetcher,
    true,
  ));
  const collections = (response?.collections ?? [])
    .filter((collection) => (
      collection.collection
      && isOpenSeaSlug(collection.collection)
      && collection.collection.toLowerCase() !== currentSlug.toLowerCase()
    ))
    .slice(0, 5)
    .map((collection) => ({
      name: safeDisplayText(collection.name, 300, collection.collection!),
      openSeaUrl: openSeaCollectionUrl(collection.collection!),
    }));
  return { username, ensName, collections };
}

export async function getCollectionInfo(
  input: string,
  apiKey: string,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<CollectionInfo> {
  const resolved = await resolveInput(input, apiKey, fetcher);
  const collection = await fetchOpenSeaJson<OpenSeaCollectionResponse>(
    `/collections/${encodeURIComponent(resolved.slug)}`,
    apiKey,
    fetcher,
    true,
  );
  if (!collection) {
    throw new UserFacingError("OpenSea could not find that NFT collection.", "COLLECTION_NOT_FOUND");
  }
  const slug = collection.collection && isOpenSeaSlug(collection.collection)
    ? collection.collection.toLowerCase()
    : resolved.slug;
  const contract = selectContract(collection, resolved.contract);
  if (!contract?.address || !contract.chain) {
    throw new UserFacingError("OpenSea did not return a contract for that collection.", "COLLECTION_CONTRACT_MISSING");
  }
  if (!CONTRACT_LOOKUP_CHAINS.includes(contract.chain as typeof CONTRACT_LOOKUP_CHAINS[number])) {
    throw new UserFacingError(
      "This collection is on an unsupported chain. Only Ethereum and Robinhood Chain are currently supported.",
      "UNSUPPORTED_CHAIN",
    );
  }
  const ownerAddress = collection.owner && isAddress(collection.owner, { strict: false })
    ? normalizeAddress(collection.owner)
    : null;

  const [stats, offers, drop, floorPrices, owner] = await Promise.all([
    optional(fetchOpenSeaJson<OpenSeaStatsResponse>(`/collections/${encodeURIComponent(slug)}/stats`, apiKey, fetcher)),
    optional(fetchOpenSeaJson<OpenSeaOffersResponse>(`/offers/collection/${encodeURIComponent(slug)}?limit=1`, apiKey, fetcher)),
    optional(fetchOpenSeaJson<OpenSeaDropResponse>(`/drops/${encodeURIComponent(slug)}`, apiKey, fetcher, true)),
    optional(fetchOpenSeaJson<OpenSeaFloorPricesResponse>(`/collections/${encodeURIComponent(slug)}/floor_prices`, apiKey, fetcher, true)),
    loadOwnerCollections(ownerAddress, slug, apiKey, fetcher),
  ]);

  const selectedMint = selectMintStage(drop, now);
  let mint: CollectionMintInfo | null = null;
  if (selectedMint) {
    const { stage, status } = selectedMint;
    const currencyAddress = stage.price_currency_address?.toLowerCase() ?? null;
    let token = currencyAddress ? tokenFromCollection(collection, currencyAddress) : null;
    const price = stage.price && /^\d+$/.test(stage.price) ? stage.price : null;
    if (currencyAddress && price && !isFreeMintPrice(price) && !token) {
      token = await optional(getOpenSeaTokenDetails(apiKey, contract.chain, currencyAddress, fetcher));
    }
    mint = {
      status,
      label: safeDisplayText(stage.label, 200, "Mint stage"),
      stageType: safeDisplayText(stage.stage_type, 100, "unknown"),
      price,
      currencyAddress,
      token,
      startsAt: parseDate(stage.start_time),
      endsAt: parseDate(stage.end_time),
      maxPerWallet: stage.max_per_wallet === null || stage.max_per_wallet === undefined
        ? null
        : String(stage.max_per_wallet),
      totalSupply: drop?.total_supply === null || drop?.total_supply === undefined ? null : String(drop.total_supply),
      maxSupply: drop?.max_supply === null || drop?.max_supply === undefined ? null : String(drop.max_supply),
    };
  }

  const day = stats?.intervals?.find((interval) => interval.interval === "one_day");
  const listingSymbol = collection.pricing_currencies?.listing_currency?.symbol?.trim()
    || allCurrencies(collection).find((currency) => currency.symbol)?.symbol?.trim()
    || null;
  const rawFloorPriceSymbol = stats?.total?.floor_price_symbol?.trim() || listingSymbol;
  const floorPriceSymbol = rawFloorPriceSymbol ? safeDisplayText(rawFloorPriceSymbol, 20, "TOKEN") : null;
  const floorCurrency = floorPriceSymbol
    ? allCurrencies(collection).find((currency) => (
      currency.symbol?.trim().toLowerCase() === floorPriceSymbol.toLowerCase()
      && currency.address
    )) ?? null
    : null;
  return {
    slug,
    name: safeDisplayText(collection.name, 300, slug),
    openSeaUrl: openSeaCollectionUrl(slug),
    chain: contract.chain,
    contractAddress: normalizeAddress(contract.address),
    ownerAddress,
    ownerUsername: owner.username,
    ownerEnsName: owner.ensName,
    mint,
    floorPrice: Number.isFinite(stats?.total?.floor_price) ? stats!.total!.floor_price! : null,
    floorPriceSymbol,
    floorPriceCurrencyAddress: floorCurrency?.address?.toLowerCase() ?? null,
    floorPriceUsdRate: floorCurrency?.usd_price ?? null,
    topOffer: topOffer(offers, collection),
    volume24h: Number.isFinite(day?.volume) ? day!.volume! : null,
    priceChange24hPercent: floorPriceChange(floorPrices, contract.chain, now),
    otherCollections: owner.collections,
  };
}
