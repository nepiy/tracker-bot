import type { SupabaseClient } from "@supabase/supabase-js";
import type { UpcomingMintStage } from "../../opensea/upcomingDrops.js";
import { isFreeMintPrice } from "../../opensea/upcomingDrops.js";
import { assertDatabaseResult } from "../client.js";

interface MintStagePriceRow {
  price: string;
  currency_address: string;
  price_version: number;
}

export interface MintPriceObservation {
  previousPrice: string | null;
  currentPrice: string;
  priceVersion: number;
  freeToPaid: boolean;
}

export interface MintPriceChangeEvent {
  stage: UpcomingMintStage;
  priceVersion: number;
}

export function isFreeToPaidTransition(previousPrice: string, currentPrice: string): boolean {
  return isFreeMintPrice(previousPrice) && /^\d+$/.test(currentPrice) && BigInt(currentPrice) > 0n;
}

export class MintStagePricesRepository {
  constructor(private readonly db: SupabaseClient) {}

  async observe(stage: UpcomingMintStage): Promise<MintPriceObservation> {
    const { data, error } = await this.db
      .from("mint_stage_prices")
      .select("price,currency_address,price_version")
      .eq("stage_id", stage.stageId)
      .eq("stage_start", stage.startsAt.toISOString())
      .maybeSingle();
    assertDatabaseResult(error, "read mint stage price");

    if (!data) {
      const { error: insertError } = await this.db.from("mint_stage_prices").insert({
        stage_id: stage.stageId,
        stage_start: stage.startsAt.toISOString(),
        drop_slug: stage.slug,
        chain: stage.chain,
        price: stage.price,
        currency_address: stage.currencyAddress,
      });
      if (insertError?.code === "23505") return this.observe(stage);
      assertDatabaseResult(insertError, "store initial mint stage price");
      return {
        previousPrice: null,
        currentPrice: stage.price,
        priceVersion: 1,
        freeToPaid: false,
      };
    }

    const row = data as MintStagePriceRow;
    const previous: MintStagePriceRow = {
      price: String(row.price),
      currency_address: String(row.currency_address),
      price_version: Number(row.price_version),
    };
    if (previous.price === stage.price && previous.currency_address === stage.currencyAddress) {
      const { error: touchError } = await this.db
        .from("mint_stage_prices")
        .update({
          drop_slug: stage.slug,
          chain: stage.chain,
          last_seen_at: new Date().toISOString(),
        })
        .eq("stage_id", stage.stageId)
        .eq("stage_start", stage.startsAt.toISOString());
      assertDatabaseResult(touchError, "touch mint stage price");
      return {
        previousPrice: previous.price,
        currentPrice: stage.price,
        priceVersion: previous.price_version,
        freeToPaid: false,
      };
    }

    const nextVersion = previous.price_version + 1;
    const freeToPaid = isFreeToPaidTransition(previous.price, stage.price);
    if (freeToPaid) {
      const { error: eventError } = await this.db.from("mint_price_change_events").upsert(
        {
          stage_id: stage.stageId,
          stage_start: stage.startsAt.toISOString(),
          price_version: nextVersion,
          previous_price: previous.price,
          new_price: stage.price,
          new_currency_address: stage.currencyAddress,
        },
        { onConflict: "stage_id,stage_start,price_version" },
      );
      assertDatabaseResult(eventError, "store mint price change event");
    }
    const { data: updated, error: updateError } = await this.db
      .from("mint_stage_prices")
      .update({
        drop_slug: stage.slug,
        chain: stage.chain,
        price: stage.price,
        currency_address: stage.currencyAddress,
        price_version: nextVersion,
        last_seen_at: new Date().toISOString(),
      })
      .eq("stage_id", stage.stageId)
      .eq("stage_start", stage.startsAt.toISOString())
      .eq("price_version", previous.price_version)
      .select("price_version")
      .maybeSingle();
    assertDatabaseResult(updateError, "update mint stage price");

    if (!updated) return this.observe(stage);
    return {
      previousPrice: previous.price,
      currentPrice: stage.price,
      priceVersion: nextVersion,
      freeToPaid,
    };
  }

  async listFreeToPaidEvents(stages: UpcomingMintStage[]): Promise<MintPriceChangeEvent[]> {
    if (!stages.length) return [];
    const stageByKey = new Map(
      stages.map((stage) => [`${stage.stageId}:${stage.startsAt.toISOString()}`, stage]),
    );
    const stageIds = [...new Set(stages.map((stage) => stage.stageId))];
    const { data, error } = await this.db
      .from("mint_price_change_events")
      .select("stage_id,stage_start,price_version,new_price,new_currency_address")
      .in("stage_id", stageIds);
    assertDatabaseResult(error, "list mint price change events");

    return (data ?? []).flatMap((row) => {
      const stage = stageByKey.get(`${row.stage_id}:${new Date(row.stage_start).toISOString()}`);
      if (!stage) return [];
      return [{
        stage: {
          ...stage,
          price: String(row.new_price),
          currencyAddress: String(row.new_currency_address),
        },
        priceVersion: Number(row.price_version),
      }];
    });
  }
}

export class MintPriceChangeNotificationsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async claim(
    userId: string,
    stage: UpcomingMintStage,
    priceVersion: number,
  ): Promise<string | null> {
    const { data, error } = await this.db
      .from("mint_price_change_notifications")
      .insert({
        user_id: userId,
        stage_id: stage.stageId,
        stage_start: stage.startsAt.toISOString(),
        price_version: priceVersion,
      })
      .select("id")
      .single();
    if (error?.code === "23505") return null;
    assertDatabaseResult(error, "claim mint price change notification");
    if (!data) throw new Error("Database claim mint price change notification returned no row");
    return String(data.id);
  }

  async markDelivered(id: string): Promise<void> {
    const { error } = await this.db
      .from("mint_price_change_notifications")
      .update({ delivered_at: new Date().toISOString() })
      .eq("id", id);
    assertDatabaseResult(error, "mark mint price change notification delivered");
  }

  async release(id: string): Promise<void> {
    const { error } = await this.db
      .from("mint_price_change_notifications")
      .delete()
      .eq("id", id)
      .is("delivered_at", null);
    assertDatabaseResult(error, "release mint price change notification claim");
  }
}
