import type { SupabaseClient } from "@supabase/supabase-js";
import type { Address } from "viem";
import { assertDatabaseResult } from "../client.js";

export interface WalletSubscriptionView {
  id: string;
  walletId: string;
  chainId: number;
  address: Address;
  active: boolean;
}

export interface WalletNotificationRecipient {
  telegramId: number;
  subscriptionId: string;
}

export interface MarketplaceWatchedWallet {
  id: string;
  chain_id: number;
  address: Address;
  recipients: WalletNotificationRecipient[];
}

interface RawWalletSubscription {
  id: string;
  active: boolean;
  wallet_id: string;
  wallets: { chain_id: number; address: Address };
}

export class WalletSubscriptionsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async subscribe(userId: string, walletId: string): Promise<{ alreadyActive: boolean }> {
    const { data: existing, error: findError } = await this.db
      .from("wallet_subscriptions")
      .select("id,active")
      .eq("user_id", userId)
      .eq("wallet_id", walletId)
      .maybeSingle();
    assertDatabaseResult(findError, "find wallet subscription");
    if (existing?.active) return { alreadyActive: true };

    const { error } = await this.db.from("wallet_subscriptions").upsert(
      {
        user_id: userId,
        wallet_id: walletId,
        active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,wallet_id" },
    );
    assertDatabaseResult(error, "upsert wallet subscription");
    return { alreadyActive: false };
  }

  async listActive(userId: string): Promise<WalletSubscriptionView[]> {
    const { data, error } = await this.db
      .from("wallet_subscriptions")
      .select("id,active,wallet_id,wallets!inner(chain_id,address)")
      .eq("user_id", userId)
      .eq("active", true)
      .order("created_at", { ascending: true });
    assertDatabaseResult(error, "list wallet subscriptions");
    return ((data ?? []) as unknown as RawWalletSubscription[]).map((row) => ({
      id: row.id,
      walletId: row.wallet_id,
      chainId: row.wallets.chain_id,
      address: row.wallets.address,
      active: row.active,
    }));
  }

  async deactivate(userId: string, subscriptionId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("wallet_subscriptions")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", subscriptionId)
      .eq("user_id", userId)
      .eq("active", true)
      .select("id");
    assertDatabaseResult(error, "deactivate wallet subscription");
    return Boolean(data?.length);
  }

  async listActiveWatched(chainId: number): Promise<MarketplaceWatchedWallet[]> {
    const { data, error } = await this.db
      .from("wallet_subscriptions")
      .select("id,wallet_id,users!inner(telegram_id),wallets!inner(chain_id,address)")
      .eq("active", true)
      .eq("wallets.chain_id", chainId);
    assertDatabaseResult(error, "list marketplace watched wallets");

    const watched = new Map<string, MarketplaceWatchedWallet>();
    for (const row of data ?? []) {
      const wallet = row.wallets as unknown as { chain_id: number; address: Address };
      const user = row.users as unknown as { telegram_id: number };
      const walletId = String(row.wallet_id);
      const recipient = { telegramId: Number(user.telegram_id), subscriptionId: String(row.id) };
      const existing = watched.get(walletId);
      if (existing) existing.recipients.push(recipient);
      else watched.set(walletId, { id: walletId, chain_id: wallet.chain_id, address: wallet.address, recipients: [recipient] });
    }
    return [...watched.values()];
  }
}
