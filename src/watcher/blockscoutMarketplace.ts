import type { Address, Hash } from "viem";
import { logger } from "../config/logger.js";
import type { Repositories } from "../database/repositories/index.js";
import type { MarketplaceWatchedWallet } from "../database/repositories/walletSubscriptions.js";
import type { ChainConfig } from "../types/index.js";
import { normalizeAddress } from "../utils/address.js";
import { ExternalServiceError } from "../utils/errors.js";
import { withRetry } from "../utils/retry.js";
import {
  recordWalletNftActivity,
  SEAPORT_ADDRESSES,
  type NftTransfer,
} from "./marketplace.js";
import type { NotificationService } from "./notifications.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_TRANSFER_PAGES = 5;
const TRANSACTION_CONCURRENCY = 4;

const BLOCKSCOUT_FALLBACKS: Partial<Record<number, string>> = {
  1: "https://eth.blockscout.com",
};

interface BlockscoutAccount {
  hash?: string;
}

interface BlockscoutToken {
  address_hash?: string;
  type?: string;
}

interface BlockscoutTransferTotal {
  token_id?: string;
  value?: string;
}

interface BlockscoutTokenTransfer {
  block_number?: number | string;
  from?: BlockscoutAccount;
  log_index?: number | null;
  timestamp?: string;
  to?: BlockscoutAccount;
  token?: BlockscoutToken;
  token_type?: string;
  total?: BlockscoutTransferTotal;
  transaction_hash?: string;
}

interface BlockscoutTokenTransfersResponse {
  items?: BlockscoutTokenTransfer[];
  next_page_params?: Record<string, string | number> | null;
}

interface BlockscoutTransaction {
  block_number?: number | string;
  from?: BlockscoutAccount;
  hash?: string;
  status?: string;
  timestamp?: string;
  to?: BlockscoutAccount | null;
  token_transfers?: BlockscoutTokenTransfer[];
  value?: string;
}

function blockscoutApiUrl(chain: ChainConfig): string | null {
  if (chain.explorerType === "blockscout") return chain.explorerApiUrl.replace(/\/$/, "");
  return BLOCKSCOUT_FALLBACKS[chain.chainId] ?? null;
}

function isNftTransfer(transfer: BlockscoutTokenTransfer): boolean {
  const type = transfer.token_type ?? transfer.token?.type;
  return type === "ERC-721" || type === "ERC-1155";
}

function asAddress(value: string | undefined): Address | null {
  if (!value) return null;
  try {
    return normalizeAddress(value);
  } catch {
    return null;
  }
}

function asHash(value: string | undefined): Hash | null {
  return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() as Hash : null;
}

function asNonNegativeBigInt(value: number | string | undefined): bigint | null {
  if (value === undefined) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
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

/**
 * Indexed reconciliation is deliberately independent from the RPC scanner.
 * A provider can reject eth_getLogs or a process can restart after its recent
 * block window has expired; Blockscout history still lets us recover the event.
 */
export class BlockscoutMarketplaceReconciler {
  private readonly processedByWallet = new Map<string, Set<string>>();

  constructor(
    private readonly repositories: Repositories,
    private readonly notifications: NotificationService,
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async reconcile(
    chain: ChainConfig,
    watchedWallets: MarketplaceWatchedWallet[],
    now = Date.now(),
  ): Promise<void> {
    const apiUrl = blockscoutApiUrl(chain);
    const activeKeys = new Set(watchedWallets.map((wallet) => `${chain.chainId}:${wallet.id}`));
    const chainPrefix = `${chain.chainId}:`;
    for (const stateKey of this.processedByWallet.keys()) {
      if (stateKey.startsWith(chainPrefix) && !activeKeys.has(stateKey)) {
        this.processedByWallet.delete(stateKey);
      }
    }
    if (!apiUrl || watchedWallets.length === 0) return;
    const cutoff = now - REPLAY_WINDOW_MS;
    for (const wallet of watchedWallets) {
      try {
        await this.reconcileWallet(apiUrl, chain, wallet, cutoff);
      } catch (error) {
        logger.warn(
          { err: error, chainId: chain.chainId, wallet: wallet.address },
          "Blockscout marketplace reconciliation wallet failed",
        );
      }
    }
  }

  private async reconcileWallet(
    apiUrl: string,
    chain: ChainConfig,
    wallet: MarketplaceWatchedWallet,
    cutoff: number,
  ): Promise<void> {
    const candidateHashes = await this.listRecentNftTransactions(apiUrl, wallet.address, cutoff);
    const stateKey = `${chain.chainId}:${wallet.id}`;
    const processed = this.processedByWallet.get(stateKey) ?? new Set<string>();
    const retained = new Set([...processed].filter((hash) => candidateHashes.has(hash)));
    const pending = [...candidateHashes].filter((hash) => !processed.has(hash));
    await mapWithConcurrency(pending, TRANSACTION_CONCURRENCY, async (hash) => {
      try {
        const transaction = await this.getTransaction(apiUrl, hash as Hash);
        await this.processTransaction(chain, wallet, transaction);
        retained.add(hash);
      } catch (error) {
        logger.warn(
          { err: error, chainId: chain.chainId, wallet: wallet.address, txHash: hash },
          "Blockscout marketplace reconciliation transaction failed",
        );
      }
    });
    this.processedByWallet.set(stateKey, retained);
    logger.debug(
      {
        chainId: chain.chainId,
        wallet: wallet.address,
        candidates: candidateHashes.size,
        attempted: pending.length,
        retained: retained.size,
      },
      "Blockscout marketplace reconciliation completed",
    );
  }

  private async listRecentNftTransactions(
    apiUrl: string,
    wallet: Address,
    cutoff: number,
  ): Promise<Set<string>> {
    const hashes = new Set<string>();
    let nextPage: Record<string, string | number> | null = null;
    for (let page = 1; page <= MAX_TRANSFER_PAGES; page += 1) {
      const query = new URLSearchParams({ type: "ERC-721,ERC-1155" });
      for (const [key, value] of Object.entries(nextPage ?? {})) query.set(key, String(value));
      const data = await this.request<BlockscoutTokenTransfersResponse>(
        `${apiUrl}/api/v2/addresses/${wallet}/token-transfers?${query.toString()}`,
      );
      let reachedCutoff = false;
      for (const transfer of data.items ?? []) {
        if (!isNftTransfer(transfer)) continue;
        const timestamp = transfer.timestamp ? new Date(transfer.timestamp).getTime() : Number.NaN;
        if (!Number.isFinite(timestamp) || timestamp < cutoff) {
          reachedCutoff = true;
          continue;
        }
        const hash = asHash(transfer.transaction_hash);
        if (hash) hashes.add(hash);
      }
      nextPage = data.next_page_params ?? null;
      if (reachedCutoff || !nextPage) break;
    }
    return hashes;
  }

  private async getTransaction(apiUrl: string, hash: Hash): Promise<BlockscoutTransaction> {
    return this.request<BlockscoutTransaction>(`${apiUrl}/api/v2/transactions/${hash}`);
  }

  private async request<T>(url: string): Promise<T> {
    return withRetry(async () => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        throw new ExternalServiceError(
          `Blockscout returned HTTP ${response.status}`,
          "blockscout",
          response.status === 429 || response.status >= 500,
        );
      }
      return await response.json() as T;
    }, {
      attempts: 4,
      initialDelayMs: 500,
      maxDelayMs: 4_000,
    });
  }

  private async processTransaction(
    chain: ChainConfig,
    wallet: MarketplaceWatchedWallet,
    transaction: BlockscoutTransaction,
  ): Promise<void> {
    if (transaction.status === "error") return;
    const hash = asHash(transaction.hash);
    const initiator = asAddress(transaction.from?.hash);
    const destination = asAddress(transaction.to?.hash);
    const blockNumber = asNonNegativeBigInt(transaction.block_number);
    const timestampMs = transaction.timestamp ? new Date(transaction.timestamp).getTime() : Number.NaN;
    if (!hash || !initiator || blockNumber === null || !Number.isFinite(timestampMs)) return;
    const timestamp = BigInt(Math.floor(timestampMs / 1_000));
    const nativeValue = asNonNegativeBigInt(transaction.value) ?? 0n;
    const transfers = transaction.token_transfers ?? [];
    const walletAddress = wallet.address.toLowerCase();
    const canonicalSeaport = destination !== null && SEAPORT_ADDRESSES.some(
      (address) => address.toLowerCase() === destination.toLowerCase(),
    );
    const erc20Out = transfers.some((transfer) => (
      (transfer.token_type ?? transfer.token?.type) === "ERC-20"
      && transfer.from?.hash?.toLowerCase() === walletAddress
    ));
    const erc20In = transfers.some((transfer) => (
      (transfer.token_type ?? transfer.token?.type) === "ERC-20"
      && transfer.to?.hash?.toLowerCase() === walletAddress
    ));
    const initiatedByWallet = initiator.toLowerCase() === walletAddress;

    const itemsPerLog = new Map<number, number>();
    for (const rawTransfer of transfers) {
      if (!isNftTransfer(rawTransfer)) continue;
      const from = asAddress(rawTransfer.from?.hash);
      const to = asAddress(rawTransfer.to?.hash);
      const contract = asAddress(rawTransfer.token?.address_hash);
      const tokenId = asNonNegativeBigInt(rawTransfer.total?.token_id);
      const transferBlock = asNonNegativeBigInt(rawTransfer.block_number) ?? blockNumber;
      if (!from || !to || !contract || tokenId === null || from.toLowerCase() === to.toLowerCase()) continue;
      const standard = (rawTransfer.token_type ?? rawTransfer.token?.type) === "ERC-1155"
        ? "ERC-1155"
        : "ERC-721";
      const quantity = standard === "ERC-1155"
        ? asNonNegativeBigInt(rawTransfer.total?.value) ?? 1n
        : 1n;
      const logIndex = rawTransfer.log_index ?? 0;
      const itemIndex = itemsPerLog.get(logIndex) ?? 0;
      itemsPerLog.set(logIndex, itemIndex + 1);
      const transfer: NftTransfer = {
        contract,
        from,
        to,
        tokenId,
        quantity: quantity > 0n ? quantity : 1n,
        standard,
        logIndex,
        itemIndex,
      };
      if (from.toLowerCase() === ZERO_ADDRESS && to.toLowerCase() === walletAddress) {
        await recordWalletNftActivity(
          "nft_mint",
          wallet,
          transfer,
          chain.chainId,
          hash,
          transferBlock,
          timestamp,
          this.repositories,
          this.notifications,
        );
        continue;
      }
      const routedThroughAnotherContract = destination !== null
        && destination.toLowerCase() !== contract.toLowerCase();
      if (to.toLowerCase() === walletAddress && from.toLowerCase() !== ZERO_ADDRESS) {
        const paidFromWallet = erc20Out || (initiatedByWallet && nativeValue > 0n);
        if (canonicalSeaport || (routedThroughAnotherContract && paidFromWallet)) {
          await recordWalletNftActivity(
            "nft_buy",
            wallet,
            transfer,
            chain.chainId,
            hash,
            transferBlock,
            timestamp,
            this.repositories,
            this.notifications,
            canonicalSeaport ? "Seaport" : "Marketplace router",
          );
        }
      }
      if (from.toLowerCase() === walletAddress && to.toLowerCase() !== ZERO_ADDRESS) {
        if (canonicalSeaport || (routedThroughAnotherContract && (erc20In || initiatedByWallet))) {
          await recordWalletNftActivity(
            "nft_sell",
            wallet,
            transfer,
            chain.chainId,
            hash,
            transferBlock,
            timestamp,
            this.repositories,
            this.notifications,
            canonicalSeaport ? "Seaport" : "Marketplace router",
          );
        }
      }
    }
  }
}
