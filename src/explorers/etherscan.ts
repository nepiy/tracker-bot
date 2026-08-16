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

const HISTORY_PAGE_SIZE = 1_000;
const MAX_HISTORY_PAGES = 20;

interface EtherscanResponse {
  status: string;
  message: string;
  result: Array<{ contractCreator: string; txHash: string }> | string;
}

interface EtherscanTransaction {
  contractAddress?: string;
  from?: string;
  hash?: string;
  isError?: string;
  timeStamp?: string;
}

interface EtherscanTransactionsResponse {
  status: string;
  message: string;
  result: EtherscanTransaction[] | string;
}

export class EtherscanExplorer implements ExplorerAdapter {
  constructor(
    private readonly chain: ChainConfig,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getContractDeployment(address: Address): Promise<ExplorerDeployment> {
    const query = new URLSearchParams({
      chainid: String(this.chain.chainId),
      module: "contract",
      action: "getcontractcreation",
      contractaddresses: address,
      apikey: this.apiKey,
    });
    const response = await this.fetcher(`${this.chain.explorerApiUrl}?${query.toString()}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new ExternalServiceError(
        `Etherscan returned HTTP ${response.status}`,
        "etherscan",
        response.status === 429 || response.status >= 500,
      );
    }
    const data = (await response.json()) as EtherscanResponse;
    const result = Array.isArray(data.result) ? data.result[0] : undefined;
    if (data.status !== "1" || !result?.contractCreator || !result.txHash) {
      throw new ExternalServiceError(
        `Etherscan contract lookup failed: ${data.message}`,
        "etherscan",
        /rate limit/i.test(String(data.result)),
      );
    }
    return {
      contractCreator: normalizeAddress(result.contractCreator),
      creationTxHash: result.txHash as Hash,
    };
  }

  async getCreatedContracts(deployer: Address): Promise<ExplorerCreatedContracts> {
    const contracts: ExplorerCreatedContract[] = [];
    let complete = true;
    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const query = new URLSearchParams({
        chainid: String(this.chain.chainId),
        module: "account",
        action: "txlist",
        address: deployer,
        startblock: "0",
        endblock: "9999999999",
        page: String(page),
        offset: String(HISTORY_PAGE_SIZE),
        sort: "asc",
        apikey: this.apiKey,
      });
      const response = await this.fetcher(`${this.chain.explorerApiUrl}?${query.toString()}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new ExternalServiceError(
          `Etherscan returned HTTP ${response.status}`,
          "etherscan",
          response.status === 429 || response.status >= 500,
        );
      }
      const data = (await response.json()) as EtherscanTransactionsResponse;
      if (!Array.isArray(data.result)) {
        if (/no transactions found/i.test(`${data.message} ${data.result}`)) break;
        throw new ExternalServiceError(
          `Etherscan transaction history failed: ${data.message}`,
          "etherscan",
          /rate limit/i.test(String(data.result)),
        );
      }
      for (const transaction of data.result) {
        if (
          transaction.isError === "1"
          || transaction.from?.toLowerCase() !== deployer.toLowerCase()
          || !transaction.contractAddress
          || !transaction.hash
        ) continue;
        try {
          const timestamp = Number(transaction.timeStamp);
          contracts.push({
            address: normalizeAddress(transaction.contractAddress),
            creationTxHash: transaction.hash as Hash,
            createdAt: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1_000) : null,
          });
        } catch {
          // Ignore malformed explorer rows without discarding the rest of the history.
        }
      }
      if (data.result.length < HISTORY_PAGE_SIZE) break;
      if (page === MAX_HISTORY_PAGES) complete = false;
    }
    return {
      contracts: [...new Map(contracts.map((contract) => [contract.address, contract])).values()],
      complete,
    };
  }
}
