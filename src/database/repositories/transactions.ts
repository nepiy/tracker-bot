import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address, Hash } from "viem";
import type { DecodedActivity } from "../../types/index.js";
import { assertDatabaseResult } from "../client.js";

export interface ActivityInsert {
  walletId: string;
  chainId: number;
  txHash: Hash;
  blockNumber: bigint;
  from: Address;
  to: Address | null;
  value: bigint;
  timestamp: Date;
  decoded: DecodedActivity;
}

export interface ActivityRow {
  id: string;
  tx_hash: Hash;
  from_address: Address;
  to_address: Address | null;
  value: string;
  activity_type: DecodedActivity["type"];
  timestamp: string;
  metadata: Record<string, unknown>;
}

export class TransactionsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async claim(chainId: number, txHash: Hash): Promise<boolean> {
    const { error } = await this.db.from("processed_transactions").insert({
      chain_id: chainId,
      tx_hash: txHash.toLowerCase(),
    });
    if (error?.code === "23505") return false;
    assertDatabaseResult(error, "claim transaction");
    return true;
  }

  async storeActivity(activity: ActivityInsert): Promise<void> {
    const { error } = await this.db.from("wallet_activity").upsert(
      {
        wallet_id: activity.walletId,
        chain_id: activity.chainId,
        tx_hash: activity.txHash.toLowerCase(),
        block_number: activity.blockNumber.toString(),
        from_address: activity.from,
        to_address: activity.to,
        value: activity.value.toString(),
        activity_type: activity.decoded.type,
        timestamp: activity.timestamp.toISOString(),
        metadata: activity.decoded.metadata,
      },
      { onConflict: "wallet_id,chain_id,tx_hash" },
    );
    assertDatabaseResult(error, "store wallet activity");
  }

  async recentForWallet(walletId: string, limit = 10): Promise<ActivityRow[]> {
    const { data, error } = await this.db
      .from("wallet_activity")
      .select("id,tx_hash,from_address,to_address,value,activity_type,timestamp,metadata")
      .eq("wallet_id", walletId)
      .order("timestamp", { ascending: false })
      .limit(Math.min(limit, 25));
    assertDatabaseResult(error, "list wallet activity");
    return (data ?? []) as ActivityRow[];
  }

  async recentForCollection(collectionId: string, limit = 10): Promise<ActivityRow[]> {
    const { data: links, error: linkError } = await this.db
      .from("collection_wallets")
      .select("wallet_id")
      .eq("collection_id", collectionId)
      .in("relationship", ["likely_dev", "tracked_fallback"]);
    assertDatabaseResult(linkError, "find collection wallet");
    const walletId = links?.[0]?.wallet_id;
    return walletId ? this.recentForWallet(String(walletId), limit) : [];
  }

  async getLastProcessedBlock(chainId: number): Promise<bigint | null> {
    const { data, error } = await this.db
      .from("chain_sync_state")
      .select("last_processed_block")
      .eq("chain_id", chainId)
      .maybeSingle();
    assertDatabaseResult(error, "read chain sync state");
    return data ? BigInt(data.last_processed_block) : null;
  }

  async setLastProcessedBlock(chainId: number, blockNumber: bigint): Promise<void> {
    const { error } = await this.db.from("chain_sync_state").upsert({
      chain_id: chainId,
      last_processed_block: blockNumber.toString(),
      updated_at: new Date().toISOString(),
    });
    assertDatabaseResult(error, "write chain sync state");
  }
}
