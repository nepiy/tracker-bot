import {
  decodeAbiParameters,
  parseAbiItem,
  parseAbiParameters,
  toEventSelector,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import type { ChainClient } from "../blockchain/clients.js";
import { logger } from "../config/logger.js";
import type { Repositories } from "../database/repositories/index.js";
import type { MarketplaceWatchedWallet } from "../database/repositories/walletSubscriptions.js";
import type { CollectionSaleWatchedCollection } from "../database/repositories/collectionSaleSubscriptions.js";
import { normalizeAddress } from "../utils/address.js";
import { withRetry } from "../utils/retry.js";
import type { NotificationService } from "./notifications.js";

export const SEAPORT_ORDER_FULFILLED_EVENT = parseAbiItem(
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)",
);
export const ERC721_TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);
export const ERC1155_TRANSFER_SINGLE_EVENT = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 tokenId, uint256 quantity)",
);
export const ERC1155_TRANSFER_BATCH_EVENT = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] tokenIds, uint256[] quantities)",
);
// Canonical cross-chain deployments published by Project OpenSea.
export const SEAPORT_ADDRESSES = [
  "0x0000000000000068f116a894984e2db1123eb395",
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
] as const satisfies readonly Address[];

const ERC721_TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const ERC1155_TRANSFER_SINGLE_TOPIC = toEventSelector("TransferSingle(address,address,address,uint256,uint256)");
const ERC1155_TRANSFER_BATCH_TOPIC = toEventSelector("TransferBatch(address,address,address,uint256[],uint256[])");
const ERC20_TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const SEAPORT_ORDER_FULFILLED_TOPIC = toEventSelector(
  "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])",
);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// QuickNode's Robinhood Chain endpoint limits eth_getLogs to five blocks.
// Keep this shared limit for every provider so one chain cannot stall alerts.
export const MARKETPLACE_LOG_RANGE_BLOCKS = 5n;
const MAX_WALLET_TOPICS_PER_QUERY = 100;
const MAX_RECEIPT_CONCURRENCY = 8;
const logQueryTails = new Map<number, Promise<void>>();

interface ReceiptLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
}

interface MarketplaceTransactionContext {
  from: Address;
  to: Address | null;
  value: bigint;
  logs: readonly ReceiptLog[];
  seaport: boolean;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes eth_getLogs requests for a chain across both live and historical
 * watchers. This prevents free-tier RPCs from treating parallel NFT filters as
 * a request burst and returning 429 responses.
 */
function paceMarketplaceLogQuery<T>(
  chainId: number,
  intervalMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = logQueryTails.get(chainId) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const next = current.then(
    () => wait(intervalMs),
    () => wait(intervalMs),
  );
  logQueryTails.set(chainId, next);
  return current;
}

export interface NftTransfer {
  contract: Address;
  from: Address;
  to: Address;
  tokenId: bigint;
  quantity: bigint;
  standard: "ERC-721" | "ERC-1155";
  logIndex: number;
  itemIndex: number;
}

function indexedAddress(topic: Hex): Address {
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

export function decodeNftTransfers(logs: readonly ReceiptLog[]): NftTransfer[] {
  const transfers: NftTransfer[] = [];
  for (const log of logs) {
    const signature = log.topics[0]?.toLowerCase();
    const logIndex = log.logIndex ?? 0;
    if (signature === ERC721_TRANSFER_TOPIC.toLowerCase() && log.topics.length === 4) {
      transfers.push({
        contract: normalizeAddress(log.address),
        from: indexedAddress(log.topics[1]!),
        to: indexedAddress(log.topics[2]!),
        tokenId: BigInt(log.topics[3]!),
        quantity: 1n,
        standard: "ERC-721",
        logIndex,
        itemIndex: 0,
      });
      continue;
    }
    if (signature === ERC1155_TRANSFER_SINGLE_TOPIC.toLowerCase() && log.topics.length === 4) {
      const [tokenId, quantity] = decodeAbiParameters(parseAbiParameters("uint256, uint256"), log.data);
      transfers.push({
        contract: normalizeAddress(log.address),
        from: indexedAddress(log.topics[2]!),
        to: indexedAddress(log.topics[3]!),
        tokenId,
        quantity,
        standard: "ERC-1155",
        logIndex,
        itemIndex: 0,
      });
      continue;
    }
    if (signature === ERC1155_TRANSFER_BATCH_TOPIC.toLowerCase() && log.topics.length === 4) {
      const [tokenIds, quantities] = decodeAbiParameters(parseAbiParameters("uint256[], uint256[]"), log.data);
      tokenIds.forEach((tokenId, itemIndex) => {
        const quantity = quantities[itemIndex];
        if (quantity === undefined) return;
        transfers.push({
          contract: normalizeAddress(log.address),
          from: indexedAddress(log.topics[2]!),
          to: indexedAddress(log.topics[3]!),
          tokenId,
          quantity,
          standard: "ERC-1155",
          logIndex,
          itemIndex,
        });
      });
    }
  }
  return transfers;
}

function hasErc20Payment(
  logs: readonly ReceiptLog[],
  wallet: Address,
  direction: "from" | "to",
): boolean {
  const topicIndex = direction === "from" ? 1 : 2;
  return logs.some((log) => (
    log.topics.length === 3
    && log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase()
    && indexedAddress(log.topics[topicIndex]!).toLowerCase() === wallet.toLowerCase()
  ));
}

function marketplaceForTransfer(
  type: "nft_buy" | "nft_sell",
  wallet: MarketplaceWatchedWallet,
  transfer: NftTransfer,
  transaction: MarketplaceTransactionContext,
): string | null {
  if (transaction.seaport) return "Seaport";
  const walletAddress = wallet.address.toLowerCase();
  const initiatedByWallet = transaction.from.toLowerCase() === walletAddress;
  const routedThroughAnotherContract = transaction.to !== null
    && transaction.to.toLowerCase() !== transfer.contract.toLowerCase();
  if (!routedThroughAnotherContract) return null;
  if (type === "nft_buy") {
    const paidFromWallet = hasErc20Payment(transaction.logs, wallet.address, "from")
      || (initiatedByWallet && transaction.value > 0n);
    return paidFromWallet ? "Marketplace router" : null;
  }
  const paidToWallet = hasErc20Payment(transaction.logs, wallet.address, "to");
  return paidToWallet || initiatedByWallet ? "Marketplace router" : null;
}

function hasErc20Movement(logs: readonly ReceiptLog[]): boolean {
  return logs.some((log) => (
    log.topics.length === 3
    && log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase()
  ));
}

function collectionSaleMarketplace(
  transfer: NftTransfer,
  transaction: MarketplaceTransactionContext,
): string | null {
  if (transaction.seaport) return "Seaport";
  const routedThroughAnotherContract = transaction.to !== null
    && transaction.to.toLowerCase() !== transfer.contract.toLowerCase();
  if (!routedThroughAnotherContract) return null;
  if (transaction.value > 0n || hasErc20Movement(transaction.logs)) return "Marketplace router";
  return null;
}

function salePayment(
  transaction: MarketplaceTransactionContext,
  seller: Address,
  buyer: Address,
): { token: Address | null; amount: bigint } | null {
  if (transaction.value > 0n) return { token: null, amount: transaction.value };
  const candidates = transaction.logs.flatMap((log) => {
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()) return [];
    const from = indexedAddress(log.topics[1]!);
    const to = indexedAddress(log.topics[2]!);
    if (from.toLowerCase() !== buyer.toLowerCase() && to.toLowerCase() !== seller.toLowerCase()) return [];
    try {
      return [{ token: normalizeAddress(log.address), amount: BigInt(log.data) }];
    } catch {
      return [];
    }
  });
  return candidates.sort((left, right) => (left.amount > right.amount ? -1 : left.amount < right.amount ? 1 : 0))[0] ?? null;
}

export async function processMarketplaceBlock(
  chainId: number,
  blockNumber: bigint,
  timestamp: bigint,
  watchedWallets: MarketplaceWatchedWallet[],
  client: ChainClient,
  repositories: Repositories,
  notifications: NotificationService,
  logQueryIntervalMs = 0,
): Promise<void> {
  await processMarketplaceRange(
    chainId,
    blockNumber,
    blockNumber,
    watchedWallets,
    client,
    repositories,
    notifications,
    async () => timestamp,
    logQueryIntervalMs,
  );
}

export async function processMarketplaceRange(
  chainId: number,
  fromBlock: bigint,
  toBlock: bigint,
  watchedWallets: MarketplaceWatchedWallet[],
  client: ChainClient,
  repositories: Repositories,
  notifications: NotificationService,
  getBlockTimestamp: (blockNumber: bigint) => Promise<bigint>,
  logQueryIntervalMs = 0,
): Promise<void> {
  if (watchedWallets.length === 0) return;
  const watchedByAddress = new Map(watchedWallets.map((wallet) => [wallet.address.toLowerCase(), wallet]));
  const watchedAddresses = [...watchedByAddress.values()].map((wallet) => wallet.address);
  const timestamps = new Map<bigint, bigint>();
  const timestampForBlock = async (blockNumber: bigint): Promise<bigint> => {
    const cached = timestamps.get(blockNumber);
    if (cached !== undefined) return cached;
    const timestamp = await getBlockTimestamp(blockNumber);
    timestamps.set(blockNumber, timestamp);
    return timestamp;
  };
  const marketplaceCandidates = new Map<Hash, bigint>();
  for (let rangeStart = fromBlock; rangeStart <= toBlock; rangeStart += MARKETPLACE_LOG_RANGE_BLOCKS) {
    const rangeEnd = rangeStart + MARKETPLACE_LOG_RANGE_BLOCKS - 1n < toBlock
      ? rangeStart + MARKETPLACE_LOG_RANGE_BLOCKS - 1n
      : toBlock;
    const queryLogs = <T>(operation: () => Promise<T>): Promise<T> => withRetry(
      () => paceMarketplaceLogQuery(chainId, logQueryIntervalMs, operation),
      {
      attempts: 4,
      initialDelayMs: 500,
      maxDelayMs: 4_000,
      onRetry: (error, attempt, delayMs) => logger.warn(
        {
          err: error,
          attempt,
          delayMs,
          chainId,
          fromBlock: rangeStart.toString(),
          toBlock: rangeEnd.toString(),
        },
        "retrying marketplace log query",
      ),
      },
    );
    const transferLogPromises: Promise<unknown[]>[] = [];
    for (let walletOffset = 0; walletOffset < watchedAddresses.length; walletOffset += MAX_WALLET_TOPICS_PER_QUERY) {
      const addresses = watchedAddresses.slice(walletOffset, walletOffset + MAX_WALLET_TOPICS_PER_QUERY);
      transferLogPromises.push(
        queryLogs(() => client.getLogs({
          event: ERC721_TRANSFER_EVENT,
          args: { to: addresses },
          fromBlock: rangeStart,
          toBlock: rangeEnd,
          strict: true,
        })),
        queryLogs(() => client.getLogs({
          event: ERC721_TRANSFER_EVENT,
          args: { from: addresses },
          fromBlock: rangeStart,
          toBlock: rangeEnd,
          strict: true,
        })),
        queryLogs(() => client.getLogs({
          event: ERC1155_TRANSFER_SINGLE_EVENT,
          args: { to: addresses },
          fromBlock: rangeStart,
          toBlock: rangeEnd,
          strict: true,
        })),
        queryLogs(() => client.getLogs({
          event: ERC1155_TRANSFER_SINGLE_EVENT,
          args: { from: addresses },
          fromBlock: rangeStart,
          toBlock: rangeEnd,
          strict: true,
        })),
        queryLogs(() => client.getLogs({
          event: ERC1155_TRANSFER_BATCH_EVENT,
          args: { to: addresses },
          fromBlock: rangeStart,
          toBlock: rangeEnd,
          strict: true,
        })),
        queryLogs(() => client.getLogs({
          event: ERC1155_TRANSFER_BATCH_EVENT,
          args: { from: addresses },
          fromBlock: rangeStart,
          toBlock: rangeEnd,
          strict: true,
        })),
      );
    }

    const transferLogs = (await Promise.all(transferLogPromises)).flat();

    for (const rawLog of transferLogs) {
      const log = rawLog as { transactionHash: Hash | null; blockNumber: bigint | null } & ReceiptLog;
      if (!log.transactionHash || log.blockNumber === null) continue;
      const transfers = decodeNftTransfers([log]);
      for (const transfer of transfers) {
        if (transfer.from.toLowerCase() === ZERO_ADDRESS) {
          const wallet = watchedByAddress.get(transfer.to.toLowerCase());
          if (!wallet) continue;
          const timestamp = await timestampForBlock(log.blockNumber);
          await recordWalletNftActivity(
            "nft_mint",
            wallet,
            transfer,
            chainId,
            log.transactionHash,
            log.blockNumber,
            timestamp,
            repositories,
            notifications,
          );
          continue;
        }
        if (
          watchedByAddress.has(transfer.from.toLowerCase())
          || watchedByAddress.has(transfer.to.toLowerCase())
        ) {
          marketplaceCandidates.set(log.transactionHash, log.blockNumber);
        }
      }
    }
  }

  await mapWithConcurrency([...marketplaceCandidates], MAX_RECEIPT_CONCURRENCY, async ([hash, blockNumber]) => {
    const receipt = await withRetry(() => client.getTransactionReceipt({ hash }), {
      attempts: 4,
      initialDelayMs: 500,
      maxDelayMs: 4_000,
      onRetry: (error, attempt, delayMs) => logger.warn(
        { err: error, attempt, delayMs, chainId, txHash: hash },
        "retrying marketplace receipt query",
      ),
    });
    if (receipt.status !== "success") return;
    const isSeaportSettlement = receipt.logs.some((log) => (
      SEAPORT_ADDRESSES.some((address) => address.toLowerCase() === log.address.toLowerCase())
      && log.topics[0]?.toLowerCase() === SEAPORT_ORDER_FULFILLED_TOPIC.toLowerCase()
    ));
    const transaction = isSeaportSettlement
      ? null
      : await withRetry(() => client.getTransaction({ hash }), {
          attempts: 4,
          initialDelayMs: 500,
          maxDelayMs: 4_000,
          onRetry: (error, attempt, delayMs) => logger.warn(
            { err: error, attempt, delayMs, chainId, txHash: hash },
            "retrying marketplace transaction query",
          ),
        });
    if (!isSeaportSettlement && !transaction) return;
    const context: MarketplaceTransactionContext = {
      from: transaction?.from ?? ZERO_ADDRESS,
      to: transaction?.to ?? null,
      value: transaction?.value ?? 0n,
      logs: receipt.logs as readonly ReceiptLog[],
      seaport: isSeaportSettlement,
    };
    const timestamp = await timestampForBlock(blockNumber);
    const transfers = decodeNftTransfers(receipt.logs as readonly ReceiptLog[]);
    for (const transfer of transfers) {
      if (transfer.from.toLowerCase() === transfer.to.toLowerCase()) continue;
      if (transfer.from.toLowerCase() !== ZERO_ADDRESS) {
        const seller = watchedByAddress.get(transfer.from.toLowerCase());
        if (seller) {
          const marketplace = marketplaceForTransfer("nft_sell", seller, transfer, context);
          if (marketplace) {
            await recordWalletNftActivity("nft_sell", seller, transfer, chainId, hash, blockNumber, timestamp, repositories, notifications, marketplace);
          }
        }
      }
      if (transfer.from.toLowerCase() !== ZERO_ADDRESS && transfer.to.toLowerCase() !== ZERO_ADDRESS) {
        const buyer = watchedByAddress.get(transfer.to.toLowerCase());
        if (buyer) {
          const marketplace = marketplaceForTransfer("nft_buy", buyer, transfer, context);
          if (marketplace) {
            await recordWalletNftActivity("nft_buy", buyer, transfer, chainId, hash, blockNumber, timestamp, repositories, notifications, marketplace);
          }
        }
      }
    }
  });
}

export async function processCollectionSaleRange(
  chainId: number,
  fromBlock: bigint,
  toBlock: bigint,
  watchedCollections: CollectionSaleWatchedCollection[],
  client: ChainClient,
  repositories: Repositories,
  notifications: NotificationService,
  getBlockTimestamp: (blockNumber: bigint) => Promise<bigint>,
  logQueryIntervalMs = 0,
): Promise<void> {
  if (watchedCollections.length === 0) return;
  const watchedByContract = new Map(watchedCollections.map((collection) => [collection.contractAddress.toLowerCase(), collection]));
  const contracts = watchedCollections.map((collection) => collection.contractAddress);
  const timestamps = new Map<bigint, bigint>();
  const timestampForBlock = async (blockNumber: bigint): Promise<bigint> => {
    const cached = timestamps.get(blockNumber);
    if (cached !== undefined) return cached;
    const timestamp = await getBlockTimestamp(blockNumber);
    timestamps.set(blockNumber, timestamp);
    return timestamp;
  };
  const candidates = new Map<Hash, bigint>();

  for (let rangeStart = fromBlock; rangeStart <= toBlock; rangeStart += MARKETPLACE_LOG_RANGE_BLOCKS) {
    const rangeEnd = rangeStart + MARKETPLACE_LOG_RANGE_BLOCKS - 1n < toBlock
      ? rangeStart + MARKETPLACE_LOG_RANGE_BLOCKS - 1n
      : toBlock;
    const queryLogs = <T>(operation: () => Promise<T>): Promise<T> => withRetry(
      () => paceMarketplaceLogQuery(chainId, logQueryIntervalMs, operation),
      {
        attempts: 4,
        initialDelayMs: 500,
        maxDelayMs: 4_000,
        onRetry: (error, attempt, delayMs) => logger.warn(
          { err: error, attempt, delayMs, chainId, fromBlock: rangeStart.toString(), toBlock: rangeEnd.toString() },
          "retrying collection sale log query",
        ),
      },
    );
    const transferLogs = (await Promise.all([
      queryLogs(() => client.getLogs({ address: contracts, event: ERC721_TRANSFER_EVENT, fromBlock: rangeStart, toBlock: rangeEnd, strict: true })),
      queryLogs(() => client.getLogs({ address: contracts, event: ERC1155_TRANSFER_SINGLE_EVENT, fromBlock: rangeStart, toBlock: rangeEnd, strict: true })),
      queryLogs(() => client.getLogs({ address: contracts, event: ERC1155_TRANSFER_BATCH_EVENT, fromBlock: rangeStart, toBlock: rangeEnd, strict: true })),
    ])).flat();
    for (const rawLog of transferLogs) {
      const log = rawLog as { transactionHash: Hash | null; blockNumber: bigint | null } & ReceiptLog;
      if (!log.transactionHash || log.blockNumber === null) continue;
      const target = watchedByContract.get(log.address.toLowerCase());
      if (!target) continue;
      const transfer = decodeNftTransfers([log])[0];
      if (!transfer || transfer.from.toLowerCase() === ZERO_ADDRESS || transfer.to.toLowerCase() === ZERO_ADDRESS) continue;
      candidates.set(log.transactionHash, log.blockNumber);
    }
  }

  await mapWithConcurrency([...candidates], MAX_RECEIPT_CONCURRENCY, async ([hash, blockNumber]) => {
    const receipt = await withRetry(() => client.getTransactionReceipt({ hash }), {
      attempts: 4,
      initialDelayMs: 500,
      maxDelayMs: 4_000,
      onRetry: (error, attempt, delayMs) => logger.warn({ err: error, attempt, delayMs, chainId, txHash: hash }, "retrying collection sale receipt query"),
    });
    if (receipt.status !== "success") return;
    const transaction = await withRetry(() => client.getTransaction({ hash }), {
      attempts: 4,
      initialDelayMs: 500,
      maxDelayMs: 4_000,
      onRetry: (error, attempt, delayMs) => logger.warn({ err: error, attempt, delayMs, chainId, txHash: hash }, "retrying collection sale transaction query"),
    });
    const isSeaportSettlement = receipt.logs.some((log) => (
      SEAPORT_ADDRESSES.some((address) => address.toLowerCase() === log.address.toLowerCase())
      && log.topics[0]?.toLowerCase() === SEAPORT_ORDER_FULFILLED_TOPIC.toLowerCase()
    ));
    const context: MarketplaceTransactionContext = {
      from: transaction.from,
      to: transaction.to ?? null,
      value: transaction.value,
      logs: receipt.logs as readonly ReceiptLog[],
      seaport: isSeaportSettlement,
    };
    const transfers = decodeNftTransfers(receipt.logs as readonly ReceiptLog[]).filter((transfer) => (
      transfer.from.toLowerCase() !== ZERO_ADDRESS
      && transfer.to.toLowerCase() !== ZERO_ADDRESS
      && watchedByContract.has(transfer.contract.toLowerCase())
      && transfer.from.toLowerCase() !== transfer.to.toLowerCase()
    ));
    const timestamp = await timestampForBlock(blockNumber);
    for (const transfer of transfers) {
      const collection = watchedByContract.get(transfer.contract.toLowerCase());
      if (!collection) continue;
      const marketplace = collectionSaleMarketplace(transfer, context);
      if (!marketplace) continue;
      const payment = salePayment(context, transfer.from, transfer.to);
      const activity = {
        collectionId: collection.id,
        chainId,
        txHash: hash,
        logIndex: transfer.logIndex,
        itemIndex: transfer.itemIndex,
        marketplace,
        nftContract: transfer.contract,
        tokenId: transfer.tokenId,
        quantity: transfer.quantity,
        standard: transfer.standard,
        seller: transfer.from,
        buyer: transfer.to,
        paymentToken: payment?.token ?? null,
        paymentAmount: payment?.amount ?? null,
        blockNumber,
        timestamp: new Date(Number(timestamp) * 1_000),
      } as const;
      if (!await repositories.collectionSaleActivity.claim(activity)) continue;
      try {
        await notifications.sendCollectionSale(collection.recipients, {
          ...activity,
          collectionName: collection.name,
          collectionSlug: collection.slug,
          hash,
        });
      } catch (error) {
        await repositories.collectionSaleActivity.release(activity).catch((releaseError) => {
          logger.error({ err: releaseError, chainId, txHash: hash, collectionId: collection.id }, "failed to release collection sale claim after notification enqueue failure");
        });
        throw error;
      }
      logger.info({ chainId, blockNumber: blockNumber.toString(), txHash: hash, collectionId: collection.id }, "processed collection sale activity");
    }
  });
}

export async function recordWalletNftActivity(
  type: "nft_buy" | "nft_sell" | "nft_mint",
  wallet: MarketplaceWatchedWallet,
  transfer: NftTransfer,
  chainId: number,
  hash: Hash,
  blockNumber: bigint,
  timestamp: bigint,
  repositories: Repositories,
  notifications: NotificationService,
  marketplace = type === "nft_mint" ? "On-chain mint" : "Seaport",
): Promise<void> {
  const counterparty = type === "nft_buy" ? transfer.from : type === "nft_sell" ? transfer.to : null;
  const activity = {
    walletId: wallet.id,
    chainId,
    txHash: hash,
    logIndex: transfer.logIndex,
    itemIndex: transfer.itemIndex,
    type,
    marketplace,
    nftContract: transfer.contract,
    tokenId: transfer.tokenId,
    quantity: transfer.quantity,
    standard: transfer.standard,
    counterparty,
    blockNumber,
    timestamp: new Date(Number(timestamp) * 1_000),
  } as const;
  if (!await repositories.marketplaceActivity.claim(activity)) return;
  try {
    await notifications.sendMarketplace(wallet.recipients, { ...activity, wallet: wallet.address, hash });
  } catch (error) {
    await repositories.marketplaceActivity.release(activity).catch((releaseError) => {
      logger.error(
        { err: releaseError, chainId, txHash: hash, wallet: wallet.address, activityType: type },
        "failed to release tracked-wallet NFT activity after notification enqueue failure",
      );
    });
    throw error;
  }
  logger.info(
    { chainId, blockNumber: blockNumber.toString(), txHash: hash, wallet: wallet.address, activityType: type },
    "processed tracked-wallet NFT activity",
  );
}
