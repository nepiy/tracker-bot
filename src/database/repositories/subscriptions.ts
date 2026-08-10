import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address } from "viem";
import { assertDatabaseResult } from "../client.js";

export interface SubscriptionView {
  id: string;
  collectionId: string;
  slug: string;
  name: string;
  chain: string;
  chainId: number;
  contractAddress: Address;
  walletAddress: Address | null;
  active: boolean;
}

export interface NotificationRecipient {
  telegramId: number;
  collectionName: string;
  collectionId: string;
}

interface RawSubscription {
  id: string;
  active: boolean;
  collection_id: string;
  collections: {
    opensea_slug: string;
    name: string;
    chain: string;
    chain_id: number;
    contract_address: Address;
    collection_wallets?: Array<{
      relationship: string;
      wallets: { address: Address };
    }>;
  };
}

export class SubscriptionsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async subscribe(userId: string, collectionId: string): Promise<{ alreadyActive: boolean }> {
    const { data: existing, error: findError } = await this.db
      .from("subscriptions")
      .select("id,active")
      .eq("user_id", userId)
      .eq("collection_id", collectionId)
      .maybeSingle();
    assertDatabaseResult(findError, "find subscription");
    if (existing?.active) return { alreadyActive: true };

    const { error } = await this.db.from("subscriptions").upsert(
      {
        user_id: userId,
        collection_id: collectionId,
        active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,collection_id" },
    );
    assertDatabaseResult(error, "upsert subscription");
    return { alreadyActive: false };
  }

  async listActive(userId: string): Promise<SubscriptionView[]> {
    const { data, error } = await this.db
      .from("subscriptions")
      .select(
        "id,active,collection_id,collections!inner(opensea_slug,name,chain,chain_id,contract_address,collection_wallets(relationship,wallets!inner(address)))",
      )
      .eq("user_id", userId)
      .eq("active", true)
      .order("created_at", { ascending: true });
    assertDatabaseResult(error, "list subscriptions");
    return ((data ?? []) as unknown as RawSubscription[]).map((row) => {
      const tracked = row.collections.collection_wallets?.find((link) =>
        ["likely_dev", "tracked_fallback"].includes(link.relationship),
      );
      return {
        id: row.id,
        collectionId: row.collection_id,
        slug: row.collections.opensea_slug,
        name: row.collections.name,
        chain: row.collections.chain,
        chainId: row.collections.chain_id,
        contractAddress: row.collections.contract_address,
        walletAddress: tracked?.wallets.address ?? null,
        active: row.active,
      };
    });
  }

  async deactivate(userId: string, subscriptionId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("subscriptions")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", subscriptionId)
      .eq("user_id", userId)
      .eq("active", true)
      .select("id");
    assertDatabaseResult(error, "deactivate subscription");
    return Boolean(data?.length);
  }

  async recipientsForWallet(walletId: string): Promise<NotificationRecipient[]> {
    const { data: links, error: linkError } = await this.db
      .from("collection_wallets")
      .select("collection_id")
      .eq("wallet_id", walletId)
      .in("relationship", ["likely_dev", "tracked_fallback"]);
    assertDatabaseResult(linkError, "find wallet collections");
    const collectionIds = [...new Set((links ?? []).map((row) => String(row.collection_id)))];
    if (collectionIds.length === 0) return [];

    const { data, error } = await this.db
      .from("subscriptions")
      .select("collection_id,users!inner(telegram_id),collections!inner(name)")
      .in("collection_id", collectionIds)
      .eq("active", true);
    assertDatabaseResult(error, "find notification recipients");
    return (data ?? []).map((row) => {
      const user = row.users as unknown as { telegram_id: number };
      const collection = row.collections as unknown as { name: string };
      return {
        telegramId: Number(user.telegram_id),
        collectionName: collection.name,
        collectionId: String(row.collection_id),
      };
    });
  }
}
