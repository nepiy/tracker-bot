import type { Address, Hash } from "viem";
import type { ChainConfig } from "../types/index.js";
import { normalizeAddress } from "../utils/address.js";
import { ExternalServiceError } from "../utils/errors.js";
import type {
  ExplorerAdapter,
  ExplorerCreatedContract,
  ExplorerCreatedContracts,
  ExplorerDeployment,
} from "./types.js";

const MAX_HISTORY_PAGES = 100;

interface AddressInfo {
  creator_address_hash?: string;
  creation_transaction_hash?: string;
}

interface BlockscoutTransaction {
  hash?: string;
  timestamp?: string;
  status?: string;
  from?: { hash?: string };
  created_contract?: { hash?: string } | null;
}

interface BlockscoutTransactionsResponse {
  items?: BlockscoutTransaction[];
  next_page_params?: Record<string, string | number> | null;
}

export class BlockscoutExplorer implements ExplorerAdapter {
  constructor(
    private readonly chain: ChainConfig,
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getContractDeployment(address: Address): Promise<ExplorerDeployment> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetcher(
      `${this.chain.explorerApiUrl}/api/v2/addresses/${address}`,
      { headers },
    );
    if (!response.ok) {
      throw new ExternalServiceError(
        `Blockscout returned HTTP ${response.status}`,
        "blockscout",
        response.status === 429 || response.status >= 500,
      );
    }
    const data = (await response.json()) as AddressInfo;
    if (!data.creator_address_hash || !data.creation_transaction_hash) {
      throw new ExternalServiceError("Blockscout has no contract creation record", "blockscout", false);
    }
    return {
      contractCreator: normalizeAddress(data.creator_address_hash),
      creationTxHash: data.creation_transaction_hash as Hash,
    };
  }

  async getCreatedContracts(deployer: Address): Promise<ExplorerCreatedContracts> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const contracts: ExplorerCreatedContract[] = [];
    let nextPage: Record<string, string | number> | null = null;
    let complete = true;
    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const query = new URLSearchParams({ filter: "from" });
      for (const [key, value] of Object.entries(nextPage ?? {})) query.set(key, String(value));
      const response = await this.fetcher(
        `${this.chain.explorerApiUrl}/api/v2/addresses/${deployer}/transactions?${query.toString()}`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) {
        throw new ExternalServiceError(
          `Blockscout returned HTTP ${response.status}`,
          "blockscout",
          response.status === 429 || response.status >= 500,
        );
      }
      const data = (await response.json()) as BlockscoutTransactionsResponse;
      for (const transaction of data.items ?? []) {
        if (
          transaction.status === "error"
          || (transaction.from?.hash && transaction.from.hash.toLowerCase() !== deployer.toLowerCase())
          || !transaction.created_contract?.hash
          || !transaction.hash
        ) continue;
        try {
          const parsedDate = transaction.timestamp ? new Date(transaction.timestamp) : null;
          contracts.push({
            address: normalizeAddress(transaction.created_contract.hash),
            creationTxHash: transaction.hash as Hash,
            createdAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
          });
        } catch {
          // Ignore malformed explorer rows without discarding the rest of the history.
        }
      }
      nextPage = data.next_page_params ?? null;
      if (!nextPage) break;
      if (page === MAX_HISTORY_PAGES) complete = false;
    }
    return {
      contracts: [...new Map(contracts.map((contract) => [contract.address, contract])).values()],
      complete,
    };
  }
}
