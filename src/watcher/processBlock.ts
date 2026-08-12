import { parseAbi, type Address, type Hash, type Hex } from "viem";
import { decodeActivity } from "../blockchain/activityDecoder.js";
import type { Repositories } from "../database/repositories/index.js";
import type { WatchedWallet } from "../database/repositories/wallets.js";
import { logger } from "../config/logger.js";
import { normalizeAddress } from "../utils/address.js";
import type { NotificationService } from "./notifications.js";
import type { SwapAssetMovement } from "./risk.js";

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const erc20BalanceOfAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

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

interface ReceiptLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

interface SwapAssetReader {
  getTransactionReceipt(parameters: { hash: Hash }): Promise<{ logs: readonly ReceiptLog[] }>;
  readContract(parameters: {
    address: Address;
    abi: typeof erc20BalanceOfAbi;
    functionName: "balanceOf";
    args: readonly [Address];
    blockNumber: bigint;
  }): Promise<unknown>;
}

function supportsSwapAssetReading(reader: BalanceReader | undefined): reader is BalanceReader & SwapAssetReader {
  const candidate = reader as Partial<SwapAssetReader> | undefined;
  return typeof candidate?.getTransactionReceipt === "function" && typeof candidate.readContract === "function";
}

function topicAddress(topic: Hex | undefined): Address | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

function outgoingErc20Amounts(logs: readonly ReceiptLog[], wallet: Address): Map<Address, bigint> {
  const totals = new Map<Address, bigint>();
  for (const log of logs) {
    // ERC-20 Transfer has exactly three topics and a 32-byte amount in data.
    // ERC-721 uses a fourth indexed token-id topic, so it is intentionally excluded.
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) {
      continue;
    }
    const from = topicAddress(log.topics[1]);
    if (from?.toLowerCase() !== wallet.toLowerCase()) continue;
    const token = normalizeAddress(log.address);
    totals.set(token, (totals.get(token) ?? 0n) + BigInt(log.data));
  }
  return totals;
}

async function swapAssetsBeforeTransaction(
  reader: SwapAssetReader,
  transaction: ProcessableTransaction,
  wallet: Address,
  blockNumber: bigint,
): Promise<SwapAssetMovement[]> {
  const receipt = await reader.getTransactionReceipt({ hash: transaction.hash });
  const amounts = outgoingErc20Amounts(receipt.logs, wallet);
  if (!amounts.size) return [];
  const balanceBlock = blockNumber > 0n ? blockNumber - 1n : 0n;
  return Promise.all([...amounts].map(async ([token, amount]) => {
    const balance = await reader.readContract({
      address: token,
      abi: erc20BalanceOfAbi,
      functionName: "balanceOf",
      args: [wallet],
      blockNumber: balanceBlock,
    });
    return {
      token,
      amount,
      balanceBefore: typeof balance === "bigint" ? balance : null,
    };
  }));
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
    let swapAssets: SwapAssetMovement[] = [];
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
    if (decoded.type === "swap" && supportsSwapAssetReading(balanceReader)) {
      try {
        swapAssets = await swapAssetsBeforeTransaction(balanceReader, item, from, block.number);
      } catch (error) {
        logger.warn(
          { err: error, chainId, blockNumber: block.number.toString(), txHash: item.hash, wallet: from },
          "failed to read pre-swap ERC-20 balances",
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
        repositories.subscriptions.recipientsForWallet(wallet.id, chainId),
        repositories.groupSubscriptions.recipientsForWallet(wallet.id, chainId),
      ]);
      await notifications.send([...personalRecipients, ...groupRecipients], {
        chainId,
        wallet: from,
        to,
        value: item.value,
        hash: item.hash,
        decoded,
        balanceBefore,
        swapAssets,
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
