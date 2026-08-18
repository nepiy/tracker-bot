import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address } from "viem";
import { isTrackingChainId } from "../../blockchain/chains.js";
import { safeDisplayText } from "../../utils/display.js";
import { assertDatabaseResult } from "../client.js";
import type { NotificationRecipient } from "./subscriptions.js";

export interface GroupSubscriptionView {
  id: string;
  collectionId: string;
  slug: string;
  name: string;
  chain: string;
  chainId: number;
  contractAddress: Address;
  walletAddress: Address | null;
}

interface RawGroupSubscription {
  id: string;
  collection_id: string;
  collections: {
    opensea_slug: string;
    name: string;
    chain: string;
    chain_id: number;
    contract_address: Address;
    collection_wallets?: Array<{
      relationship: string;
      wallets: { address: Address; chain_id: number };
    }>;
  };
}

export class GroupSubscriptionsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async subscribe(chatId: number, collectionId: string): Promise<{ alreadyActive: boolean }> {
    const { data: existing, error: findError } = await this.db
      .from("group_subscriptions")
      .select("id,active")
      .eq("chat_id", chatId)
      .eq("collection_id", collectionId)
      .maybeSingle();
    assertDatabaseResult(findError, "find group subscription");
    if (existing?.active) return { alreadyActive: true };

    const { error } = await this.db.from("group_subscriptions").upsert(
      { chat_id: chatId, collection_id: collectionId, active: true, updated_at: new Date().toISOString() },
      { onConflict: "chat_id,collection_id" },
    );
    assertDatabaseResult(error, "upsert group subscription");
    return { alreadyActive: false };
  }

  async listActive(chatId: number): Promise<GroupSubscriptionView[]> {
    const { data, error } = await this.db
      .from("group_subscriptions")
      .select(
        "id,collection_id,collections!inner(opensea_slug,name,chain,chain_id,contract_address,collection_wallets(relationship,wallets!inner(address,chain_id)))",
      )
      .eq("chat_id", chatId)
      .eq("active", true)
      .order("created_at", { ascending: true });
    assertDatabaseResult(error, "list group subscriptions");
    return ((data ?? []) as unknown as RawGroupSubscription[]).flatMap((row) => {
      if (!isTrackingChainId(row.collections.chain_id)) return [];
      const tracked = row.collections.collection_wallets?.find((link) =>
        ["likely_dev", "tracked_fallback"].includes(link.relationship)
          && link.wallets.chain_id === row.collections.chain_id,
      );
      return [{
        id: row.id,
        collectionId: row.collection_id,
        slug: row.collections.opensea_slug,
        name: safeDisplayText(row.collections.name, 300, row.collections.opensea_slug),
        chain: row.collections.chain,
        chainId: row.collections.chain_id,
        contractAddress: row.collections.contract_address,
        walletAddress: tracked?.wallets.address ?? null,
      }];
    });
  }

  async deactivate(chatId: number, subscriptionId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("group_subscriptions")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", subscriptionId)
      .eq("chat_id", chatId)
      .eq("active", true)
      .select("id");
    assertDatabaseResult(error, "deactivate group subscription");
    return Boolean(data?.length);
  }

  async recipientsForWallet(walletId: string, chainId: number): Promise<NotificationRecipient[]> {
    if (!isTrackingChainId(chainId)) return [];
    const { data: links, error: linkError } = await this.db
      .from("collection_wallets")
      .select("collection_id")
      .eq("wallet_id", walletId)
      .in("relationship", ["likely_dev", "tracked_fallback", "cross_chain_dev"]);
    assertDatabaseResult(linkError, "find group wallet collections");
    const collectionIds = [...new Set((links ?? []).map((row) => String(row.collection_id)))];
    if (collectionIds.length === 0) return [];

    const { data, error } = await this.db
      .from("group_subscriptions")
      .select("chat_id,collection_id,collections!inner(name,chain_id)")
      .in("collection_id", collectionIds)
      .eq("active", true);
    assertDatabaseResult(error, "find group notification recipients");
    return (data ?? []).flatMap((row) => {
      const collection = row.collections as unknown as { name: string; chain_id: number };
      if (Number(collection.chain_id) !== chainId) return [];
      return [{
        telegramId: Number(row.chat_id),
        collectionName: safeDisplayText(collection.name, 300, "Unnamed collection"),
        collectionId: String(row.collection_id),
        chainId: Number(collection.chain_id),
      }];
    });
  }
}
