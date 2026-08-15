import type { SupabaseClient } from "@supabase/supabase-js";
import { BASE_CHAIN_ID } from "../../blockchain/chains.js";
import { assertDatabaseResult } from "../client.js";

export type NftPriceAlertDirection = "at_or_below" | "at_or_above";

export interface CreateNftPriceAlert {
  userId: string;
  slug: string;
  collectionName: string;
  chain: string;
  contractAddress: string;
  targetPrice: string;
  initialFloorPrice: string;
  currencySymbol: string;
  currencyAddress: string | null;
  usdRate: string | null;
  direction: NftPriceAlertDirection;
}

export interface NftPriceAlertView {
  id: string;
  userId: string;
  slug: string;
  collectionName: string;
  chain: string;
  contractAddress: string;
  targetPrice: string;
  initialFloorPrice: string;
  lastFloorPrice: string | null;
  currencySymbol: string;
  currencyAddress: string | null;
  usdRate: string | null;
  direction: NftPriceAlertDirection;
  status: "active" | "sending";
  claimedAt: string | null;
  createdAt: string;
}

export interface NftPriceAlertRecipient extends NftPriceAlertView {
  telegramId: number;
}

interface NftPriceAlertRow {
  id: string;
  user_id: string;
  opensea_slug: string;
  collection_name: string;
  chain: string;
  contract_address: string;
  target_price: string;
  initial_floor_price: string;
  last_floor_price: string | null;
  currency_symbol: string;
  currency_address: string | null;
  last_usd_rate: string | null;
  direction: NftPriceAlertDirection;
  status: "active" | "sending" | "triggered" | "cancelled";
  claimed_at: string | null;
  created_at: string;
  users?: { telegram_id: number };
}

const ALERT_COLUMNS = [
  "id",
  "user_id",
  "opensea_slug",
  "collection_name",
  "chain",
  "contract_address",
  "target_price",
  "initial_floor_price",
  "last_floor_price",
  "currency_symbol",
  "currency_address",
  "last_usd_rate",
  "direction",
  "status",
  "claimed_at",
  "created_at",
].join(",");

function toView(row: NftPriceAlertRow): NftPriceAlertView {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    slug: String(row.opensea_slug),
    collectionName: String(row.collection_name),
    chain: String(row.chain),
    contractAddress: String(row.contract_address),
    targetPrice: String(row.target_price),
    initialFloorPrice: String(row.initial_floor_price),
    lastFloorPrice: row.last_floor_price === null ? null : String(row.last_floor_price),
    currencySymbol: String(row.currency_symbol),
    currencyAddress: row.currency_address === null ? null : String(row.currency_address),
    usdRate: row.last_usd_rate === null ? null : String(row.last_usd_rate),
    direction: row.direction,
    status: row.status === "sending" ? "sending" : "active",
    claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
    createdAt: String(row.created_at),
  };
}

export class NftPriceAlertsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async create(input: CreateNftPriceAlert): Promise<NftPriceAlertView | null> {
    const { data, error } = await this.db
      .from("nft_price_alerts")
      .insert({
        user_id: input.userId,
        opensea_slug: input.slug,
        collection_name: input.collectionName,
        chain: input.chain,
        contract_address: input.contractAddress,
        target_price: input.targetPrice,
        initial_floor_price: input.initialFloorPrice,
        last_floor_price: input.initialFloorPrice,
        currency_symbol: input.currencySymbol,
        currency_address: input.currencyAddress,
        last_usd_rate: input.usdRate,
        last_usd_rate_at: input.usdRate === null ? null : new Date().toISOString(),
        direction: input.direction,
      })
      .select(ALERT_COLUMNS)
      .single();
    if (error?.code === "23505") return null;
    assertDatabaseResult(error, "create NFT floor price alert");
    if (!data) throw new Error("Database create NFT floor price alert returned no row");
    return toView(data as unknown as NftPriceAlertRow);
  }

  async listActive(userId: string): Promise<NftPriceAlertView[]> {
    const { data, error } = await this.db
      .from("nft_price_alerts")
      .select(ALERT_COLUMNS)
      .eq("user_id", userId)
      .in("status", ["active", "sending"])
      .order("created_at", { ascending: true });
    assertDatabaseResult(error, "list NFT floor price alerts");
    return ((data ?? []) as unknown as NftPriceAlertRow[])
      .filter((row) => row.chain !== "base" && row.chain !== String(BASE_CHAIN_ID))
      .map(toView);
  }

  async cancel(userId: string, alertId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("nft_price_alerts")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", alertId)
      .eq("user_id", userId)
      .eq("status", "active")
      .select("id");
    assertDatabaseResult(error, "cancel NFT floor price alert");
    return Boolean(data?.length);
  }

  async releaseStaleClaims(before: Date): Promise<void> {
    const { error } = await this.db
      .from("nft_price_alerts")
      .update({ status: "active", claimed_at: null, updated_at: new Date().toISOString() })
      .eq("status", "sending")
      .lt("claimed_at", before.toISOString());
    assertDatabaseResult(error, "release stale NFT floor price alert claims");
  }

  async listForWatcher(): Promise<NftPriceAlertRecipient[]> {
    const { data, error } = await this.db
      .from("nft_price_alerts")
      .select(`${ALERT_COLUMNS},users!inner(telegram_id)`)
      .eq("status", "active")
      .order("created_at", { ascending: true });
    assertDatabaseResult(error, "list active NFT floor price alerts for watcher");
    return ((data ?? []) as unknown as NftPriceAlertRow[])
      .filter((row) => row.chain !== "base" && row.chain !== String(BASE_CHAIN_ID))
      .map((row) => ({
        ...toView(row),
        telegramId: Number(row.users!.telegram_id),
      }));
  }

  async recordFloor(
    slug: string,
    floorPrice: string,
    usdRate: string | null,
    checkedAt: Date,
  ): Promise<void> {
    const update: Record<string, string> = {
      last_floor_price: floorPrice,
      last_checked_at: checkedAt.toISOString(),
      updated_at: checkedAt.toISOString(),
    };
    if (usdRate !== null) {
      update.last_usd_rate = usdRate;
      update.last_usd_rate_at = checkedAt.toISOString();
    }
    const { error } = await this.db
      .from("nft_price_alerts")
      .update(update)
      .eq("opensea_slug", slug)
      .eq("status", "active");
    assertDatabaseResult(error, "record NFT collection floor price");
  }

  async claim(alertId: string, claimedAt: Date): Promise<boolean> {
    const { data, error } = await this.db
      .from("nft_price_alerts")
      .update({
        status: "sending",
        claimed_at: claimedAt.toISOString(),
        updated_at: claimedAt.toISOString(),
      })
      .eq("id", alertId)
      .eq("status", "active")
      .select("id");
    assertDatabaseResult(error, "claim NFT floor price alert");
    return Boolean(data?.length);
  }

  async markTriggered(alertId: string, floorPrice: string, triggeredAt: Date): Promise<void> {
    const { data, error } = await this.db
      .from("nft_price_alerts")
      .update({
        status: "triggered",
        claimed_at: null,
        triggered_at: triggeredAt.toISOString(),
        last_floor_price: floorPrice,
        last_checked_at: triggeredAt.toISOString(),
        updated_at: triggeredAt.toISOString(),
      })
      .eq("id", alertId)
      .eq("status", "sending")
      .select("id");
    assertDatabaseResult(error, "expire delivered NFT floor price alert");
    if (data?.length !== 1) throw new Error("Delivered NFT floor price alert was not expired");
  }

  async release(alertId: string): Promise<void> {
    const { error } = await this.db
      .from("nft_price_alerts")
      .update({ status: "active", claimed_at: null, updated_at: new Date().toISOString() })
      .eq("id", alertId)
      .eq("status", "sending");
    assertDatabaseResult(error, "release NFT floor price alert claim");
  }
}
