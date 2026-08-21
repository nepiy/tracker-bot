import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address } from "viem";
import { isTrackingChainId } from "../../blockchain/chains.js";
import { safeDisplayText } from "../../utils/display.js";
import { assertDatabaseResult } from "../client.js";

export interface CollectionSaleSubscriptionView {
  id: string;
  collectionId: string;
  slug: string;
  name: string;
  chain: string;
  chainId: number;
  contractAddress: Address;
  active: boolean;
}

export interface CollectionSaleNotificationRecipient {
  telegramId: number;
  subscriptionId: string;
}

export interface CollectionSaleWatchedCollection {
  id: string;
  slug: string;
  name: string;
  chainId: number;
  contractAddress: Address;
  recipients: CollectionSaleNotificationRecipient[];
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
  };
}

export class CollectionSaleSubscriptionsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async subscribe(userId: string, collectionId: string): Promise<{ alreadyActive: boolean }> {
    const { data: existing, error: findError } = await this.db
      .from("collection_sale_subscriptions")
      .select("id,active")
      .eq("user_id", userId)
      .eq("collection_id", collectionId)
      .maybeSingle();
    assertDatabaseResult(findError, "find collection sale subscription");
    if (existing?.active) return { alreadyActive: true };

    const { error } = await this.db.from("collection_sale_subscriptions").upsert(
      {
        user_id: userId,
        collection_id: collectionId,
        active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,collection_id" },
    );
    assertDatabaseResult(error, "upsert collection sale subscription");
    return { alreadyActive: false };
  }

  async listActive(userId: string): Promise<CollectionSaleSubscriptionView[]> {
    const { data, error } = await this.db
      .from("collection_sale_subscriptions")
      .select("id,active,collection_id,collections!inner(opensea_slug,name,chain,chain_id,contract_address)")
      .eq("user_id", userId)
      .eq("active", true)
      .order("created_at", { ascending: true });
    assertDatabaseResult(error, "list collection sale subscriptions");
    return ((data ?? []) as unknown as RawSubscription[]).flatMap((row) => {
      if (!isTrackingChainId(row.collections.chain_id)) return [];
      return [{
        id: row.id,
        collectionId: row.collection_id,
        slug: row.collections.opensea_slug,
        name: safeDisplayText(row.collections.name, 300, row.collections.opensea_slug),
        chain: row.collections.chain,
        chainId: row.collections.chain_id,
        contractAddress: row.collections.contract_address,
        active: row.active,
      }];
    });
  }

  async deactivate(userId: string, subscriptionId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("collection_sale_subscriptions")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", subscriptionId)
      .eq("user_id", userId)
      .eq("active", true)
      .select("id");
    assertDatabaseResult(error, "deactivate collection sale subscription");
    return Boolean(data?.length);
  }

  async listActiveWatched(chainId: number): Promise<CollectionSaleWatchedCollection[]> {
    if (!isTrackingChainId(chainId)) return [];
    const { data, error } = await this.db
      .from("collection_sale_subscriptions")
      .select("id,collection_id,users!inner(telegram_id),collections!inner(opensea_slug,name,chain_id,contract_address)")
      .eq("active", true)
      .eq("collections.chain_id", chainId);
    assertDatabaseResult(error, "list collection sale watch targets");

    const watched = new Map<string, CollectionSaleWatchedCollection>();
    for (const row of data ?? []) {
      const collection = row.collections as unknown as {
        opensea_slug: string;
        name: string;
        chain_id: number;
        contract_address: Address;
      };
      const user = row.users as unknown as { telegram_id: number };
      const collectionId = String(row.collection_id);
      const recipient = {
        telegramId: Number(user.telegram_id),
        subscriptionId: String(row.id),
      };
      const existing = watched.get(collectionId);
      if (existing) {
        existing.recipients.push(recipient);
      } else {
        watched.set(collectionId, {
          id: collectionId,
          slug: collection.opensea_slug,
          name: safeDisplayText(collection.name, 300, collection.opensea_slug),
          chainId: Number(collection.chain_id),
          contractAddress: collection.contract_address,
          recipients: [recipient],
        });
      }
    }
    return [...watched.values()];
  }
}
