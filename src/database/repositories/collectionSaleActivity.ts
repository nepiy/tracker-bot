import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address, Hash } from "viem";
import { assertDatabaseResult } from "../client.js";

export interface CollectionSaleActivityInsert {
  collectionId: string;
  chainId: number;
  txHash: Hash;
  logIndex: number;
  itemIndex: number;
  marketplace: string;
  nftContract: Address;
  tokenId: bigint;
  quantity: bigint;
  standard: "ERC-721" | "ERC-1155";
  seller: Address;
  buyer: Address;
  paymentToken: Address | null;
  paymentAmount: bigint | null;
  blockNumber: bigint;
  timestamp: Date;
}

export class CollectionSaleActivityRepository {
  constructor(private readonly db: SupabaseClient) {}

  async claim(activity: CollectionSaleActivityInsert): Promise<boolean> {
    const { error } = await this.db.from("collection_sale_activity").insert({
      collection_id: activity.collectionId,
      chain_id: activity.chainId,
      tx_hash: activity.txHash.toLowerCase(),
      log_index: activity.logIndex,
      item_index: activity.itemIndex,
      marketplace: activity.marketplace,
      nft_contract: activity.nftContract,
      token_id: activity.tokenId.toString(),
      quantity: activity.quantity.toString(),
      standard: activity.standard,
      seller: activity.seller,
      buyer: activity.buyer,
      payment_token: activity.paymentToken,
      payment_amount: activity.paymentAmount?.toString() ?? null,
      block_number: activity.blockNumber.toString(),
      timestamp: activity.timestamp.toISOString(),
      metadata: {},
    });
    if (error?.code === "23505") return false;
    assertDatabaseResult(error, "claim collection sale activity");
    return true;
  }

  async release(activity: CollectionSaleActivityInsert): Promise<void> {
    const { error } = await this.db
      .from("collection_sale_activity")
      .delete()
      .eq("collection_id", activity.collectionId)
      .eq("chain_id", activity.chainId)
      .eq("tx_hash", activity.txHash.toLowerCase())
      .eq("log_index", activity.logIndex)
      .eq("item_index", activity.itemIndex);
    assertDatabaseResult(error, "release collection sale activity claim");
  }
}
