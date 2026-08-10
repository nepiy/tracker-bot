import type { Address, Hash } from "viem";
import type { ChainConfig } from "../types/index.js";
import { normalizeAddress } from "../utils/address.js";
import { ExternalServiceError } from "../utils/errors.js";
import type { ExplorerAdapter, ExplorerDeployment } from "./types.js";

interface AddressInfo {
  creator_address_hash?: string;
  creation_transaction_hash?: string;
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
}
