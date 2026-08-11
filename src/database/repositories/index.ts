import type { SupabaseClient } from "@supabase/supabase-js";
import { CollectionsRepository } from "./collections.js";
import { SubscriptionsRepository } from "./subscriptions.js";
import { TransactionsRepository } from "./transactions.js";
import { UsersRepository } from "./users.js";
import { WalletsRepository } from "./wallets.js";
import { WalletSubscriptionsRepository } from "./walletSubscriptions.js";
import { MarketplaceActivityRepository } from "./marketplaceActivity.js";
import { GroupSubscriptionsRepository } from "./groupSubscriptions.js";
import { FreeMintNotificationsRepository } from "./freeMintNotifications.js";
import {
  MintPriceChangeNotificationsRepository,
  MintStagePricesRepository,
} from "./mintStagePrices.js";

export function createRepositories(db: SupabaseClient) {
  return {
    users: new UsersRepository(db),
    collections: new CollectionsRepository(db),
    wallets: new WalletsRepository(db),
    subscriptions: new SubscriptionsRepository(db),
    transactions: new TransactionsRepository(db),
    walletSubscriptions: new WalletSubscriptionsRepository(db),
    marketplaceActivity: new MarketplaceActivityRepository(db),
    groupSubscriptions: new GroupSubscriptionsRepository(db),
    freeMintNotifications: new FreeMintNotificationsRepository(db),
    mintStagePrices: new MintStagePricesRepository(db),
    mintPriceChangeNotifications: new MintPriceChangeNotificationsRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
