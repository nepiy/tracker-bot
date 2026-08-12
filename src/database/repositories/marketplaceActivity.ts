import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address, Hash } from "viem";
import { assertDatabaseResult } from "../client.js";

export interface MarketplaceActivityInsert {
  walletId: string;
  chainId: number;
  txHash: Hash;
  logIndex: number;
  itemIndex: number;
  type: "nft_buy" | "nft_sell";
  marketplace: string;
  nftContract: Address;
  tokenId: bigint;
  quantity: bigint;
  standard: "ERC-721" | "ERC-1155";
  counterparty: Address | null;
  blockNumber: bigint;
  timestamp: Date;
}

export class MarketplaceActivityRepository {
  constructor(private readonly db: SupabaseClient) {}

  async claim(activity: MarketplaceActivityInsert): Promise<boolean> {
    const { error } = await this.db.from("marketplace_activity").insert({
      wallet_id: activity.walletId,
      chain_id: activity.chainId,
      tx_hash: activity.txHash.toLowerCase(),
      log_index: activity.logIndex,
      item_index: activity.itemIndex,
      activity_type: activity.type,
      marketplace: activity.marketplace,
      nft_contract: activity.nftContract,
      token_id: activity.tokenId.toString(),
      quantity: activity.quantity.toString(),
      counterparty: activity.counterparty,
      block_number: activity.blockNumber.toString(),
      timestamp: activity.timestamp.toISOString(),
      metadata: { standard: activity.standard },
    });
    if (error?.code === "23505") return false;
    assertDatabaseResult(error, "claim marketplace activity");
    return true;
  }

  async release(activity: MarketplaceActivityInsert): Promise<void> {
    const { error } = await this.db
      .from("marketplace_activity")
      .delete()
      .eq("wallet_id", activity.walletId)
      .eq("chain_id", activity.chainId)
      .eq("tx_hash", activity.txHash.toLowerCase())
      .eq("log_index", activity.logIndex)
      .eq("item_index", activity.itemIndex)
      .eq("activity_type", activity.type);
    assertDatabaseResult(error, "release marketplace activity claim");
  }
}
