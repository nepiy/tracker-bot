import type { Address, Hash, Hex } from "viem";
import { decodeActivity } from "../blockchain/activityDecoder.js";
import type { Repositories } from "../database/repositories/index.js";
import type { WatchedWallet } from "../database/repositories/wallets.js";
import { logger } from "../config/logger.js";
import { normalizeAddress } from "../utils/address.js";
import type { NotificationService } from "./notifications.js";

export interface ProcessableTransaction {
  hash: Hash;
  from: Address;
  to: Address | null;
  value: bigint;
  input: Hex;
}

export interface ProcessableBlock {
  number: bigint;
  timestamp: bigint;
  transactions: readonly (ProcessableTransaction | Hash)[];
}

export interface BalanceReader {
  getBalance(parameters: { address: Address; blockNumber: bigint }): Promise<bigint>;
}

export function isOutgoingTransaction(
  transaction: Pick<ProcessableTransaction, "from">,
  watchedAddresses: ReadonlySet<string>,
): boolean {
  return watchedAddresses.has(transaction.from.toLowerCase());
}

export async function processBlock(
  chainId: number,
  block: ProcessableBlock,
  watchedWallets: WatchedWallet[],
  repositories: Repositories,
  notifications: NotificationService,
  balanceReader?: BalanceReader,
): Promise<void> {
  const watchedByAddress = new Map(
    watchedWallets.map((wallet) => [wallet.address.toLowerCase(), wallet]),
  );
  const watchedAddresses = new Set(watchedByAddress.keys());

  for (const item of block.transactions) {
    if (typeof item === "string") continue;
    if (!isOutgoingTransaction(item, watchedAddresses)) continue;
    const wallet = watchedByAddress.get(item.from.toLowerCase());
    if (!wallet) continue;

    const from = normalizeAddress(item.from);
    const to = item.to ? normalizeAddress(item.to) : null;
    const decoded = decodeActivity({ to, value: item.value, input: item.input });
    let balanceBefore: bigint | null = null;
    if (balanceReader && item.value > 0n) {
      try {
        balanceBefore = await balanceReader.getBalance({
          address: from,
          blockNumber: block.number > 0n ? block.number - 1n : 0n,
        });
      } catch (error) {
        logger.warn(
          { err: error, chainId, blockNumber: block.number.toString(), wallet: from },
          "failed to read pre-block wallet balance",
        );
      }
    }

    const claimed = await repositories.transactions.claim(chainId, item.hash);
    if (!claimed) continue;
    try {
      await repositories.transactions.storeActivity({
        walletId: wallet.id,
        chainId,
        txHash: item.hash,
        blockNumber: block.number,
        from,
        to,
        value: item.value,
        timestamp: new Date(Number(block.timestamp) * 1_000),
        decoded,
      });
      const [personalRecipients, groupRecipients] = await Promise.all([
        repositories.subscriptions.recipientsForWallet(wallet.id),
        repositories.groupSubscriptions.recipientsForWallet(wallet.id),
      ]);
      await notifications.send([...personalRecipients, ...groupRecipients], {
        chainId,
        wallet: from,
        to,
        value: item.value,
        hash: item.hash,
        decoded,
        balanceBefore,
      });
    } catch (error) {
      await repositories.transactions.releaseClaim(chainId, item.hash).catch((releaseError) => {
        logger.error(
          { err: releaseError, chainId, txHash: item.hash },
          "failed to release transaction after notification enqueue failure",
        );
      });
      throw error;
    }
    logger.info(
      { chainId, blockNumber: block.number.toString(), txHash: item.hash, wallet: from, activityType: decoded.type },
      "processed outgoing wallet transaction",
    );
  }
}
