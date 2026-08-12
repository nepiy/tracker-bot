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
import { normalizeAddress } from "../utils/address.js";
import type { NotificationService } from "./notifications.js";

export const SEAPORT_ORDER_FULFILLED_EVENT = parseAbiItem(
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)",
);
// Canonical cross-chain deployments published by Project OpenSea.
export const SEAPORT_ADDRESSES = [
  "0x0000000000000068f116a894984e2db1123eb395",
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
] as const satisfies readonly Address[];

const ERC721_TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const ERC1155_TRANSFER_SINGLE_TOPIC = toEventSelector("TransferSingle(address,address,address,uint256,uint256)");
const ERC1155_TRANSFER_BATCH_TOPIC = toEventSelector("TransferBatch(address,address,address,uint256[],uint256[])");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface ReceiptLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
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

export async function processMarketplaceBlock(
  chainId: number,
  blockNumber: bigint,
  timestamp: bigint,
  watchedWallets: MarketplaceWatchedWallet[],
  client: ChainClient,
  repositories: Repositories,
  notifications: NotificationService,
): Promise<void> {
  if (watchedWallets.length === 0) return;
  const watchedByAddress = new Map(watchedWallets.map((wallet) => [wallet.address.toLowerCase(), wallet]));
  const settlementLogs = await client.getLogs({
    address: [...SEAPORT_ADDRESSES],
    event: SEAPORT_ORDER_FULFILLED_EVENT,
    fromBlock: blockNumber,
    toBlock: blockNumber,
  });
  const hashes = [...new Set(settlementLogs.flatMap((log) => log.transactionHash ? [log.transactionHash] : []))];

  for (const hash of hashes) {
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== "success") continue;
    const transfers = decodeNftTransfers(receipt.logs as readonly ReceiptLog[]);
    for (const transfer of transfers) {
      if (transfer.from.toLowerCase() === transfer.to.toLowerCase()) continue;
      if (transfer.from.toLowerCase() !== ZERO_ADDRESS) {
        const seller = watchedByAddress.get(transfer.from.toLowerCase());
        if (seller) {
          await recordTrade("nft_sell", seller, transfer, chainId, hash, blockNumber, timestamp, repositories, notifications);
        }
      }
      if (transfer.to.toLowerCase() !== ZERO_ADDRESS) {
        const buyer = watchedByAddress.get(transfer.to.toLowerCase());
        if (buyer) {
          await recordTrade("nft_buy", buyer, transfer, chainId, hash, blockNumber, timestamp, repositories, notifications);
        }
      }
    }
  }
}

async function recordTrade(
  type: "nft_buy" | "nft_sell",
  wallet: MarketplaceWatchedWallet,
  transfer: NftTransfer,
  chainId: number,
  hash: Hash,
  blockNumber: bigint,
  timestamp: bigint,
  repositories: Repositories,
  notifications: NotificationService,
): Promise<void> {
  const counterparty = type === "nft_buy" ? transfer.from : transfer.to;
  const activity = {
    walletId: wallet.id,
    chainId,
    txHash: hash,
    logIndex: transfer.logIndex,
    itemIndex: transfer.itemIndex,
    type,
    marketplace: "Seaport",
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
        "failed to release marketplace activity after notification enqueue failure",
      );
    });
    throw error;
  }
  logger.info(
    { chainId, blockNumber: blockNumber.toString(), txHash: hash, wallet: wallet.address, activityType: type },
    "processed marketplace wallet activity",
  );
}
