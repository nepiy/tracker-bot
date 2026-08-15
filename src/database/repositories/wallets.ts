import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address } from "viem";
import { BASE_CHAIN_ID } from "../../blockchain/chains.js";
import type { WalletEvidence } from "../../types/index.js";
import { assertDatabaseResult } from "../client.js";

export interface WalletRow {
  id: string;
  chain_id: number;
  address: Address;
}

export interface WatchedWallet extends WalletRow {
  collectionIds: string[];
}

export class WalletsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async upsert(chainId: number, address: Address): Promise<WalletRow> {
    const { data, error } = await this.db
      .from("wallets")
      .upsert({ chain_id: chainId, address }, { onConflict: "chain_id,address" })
      .select("id,chain_id,address")
      .single();
    assertDatabaseResult(error, "upsert wallet");
    return data as WalletRow;
  }

  async linkCollection(
    collectionId: string,
    walletId: string,
    relationship: string,
    confidence: number,
    evidence: WalletEvidence[],
  ): Promise<void> {
    const { error } = await this.db.from("collection_wallets").upsert(
      {
        collection_id: collectionId,
        wallet_id: walletId,
        relationship,
        confidence,
        evidence,
      },
      { onConflict: "collection_id,wallet_id,relationship" },
    );
    assertDatabaseResult(error, "link collection wallet");
  }

  async listActiveWatched(): Promise<WatchedWallet[]> {
    const { data: active, error: subscriptionError } = await this.db
      .from("subscriptions")
      .select("collection_id,collections!inner(chain_id)")
      .eq("active", true);
    assertDatabaseResult(subscriptionError, "list active subscriptions");
    const collectionIds = [...new Set((active ?? []).flatMap((row) => {
      const collection = row.collections as unknown as { chain_id: number };
      return Number(collection.chain_id) === BASE_CHAIN_ID ? [] : [String(row.collection_id)];
    }))];
    if (collectionIds.length === 0) return [];

    const { data, error } = await this.db
      .from("collection_wallets")
      .select("collection_id,wallet_id,relationship,wallets!inner(id,chain_id,address)")
      .in("collection_id", collectionIds)
      .in("relationship", ["likely_dev", "tracked_fallback", "cross_chain_dev"]);
    assertDatabaseResult(error, "list watched wallets");

    const deduplicated = new Map<string, WatchedWallet>();
    for (const raw of data ?? []) {
      const wallet = raw.wallets as unknown as WalletRow;
      const existing = deduplicated.get(wallet.id);
      if (existing) {
        existing.collectionIds.push(String(raw.collection_id));
      } else {
        deduplicated.set(wallet.id, { ...wallet, collectionIds: [String(raw.collection_id)] });
      }
    }
    return [...deduplicated.values()];
  }
}
