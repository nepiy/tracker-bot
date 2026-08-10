import type { Address, Hash } from "viem";
import type { ChainConfig } from "../types/index.js";
import { normalizeAddress } from "../utils/address.js";
import { ExternalServiceError } from "../utils/errors.js";
import type { ExplorerAdapter, ExplorerDeployment } from "./types.js";

interface EtherscanResponse {
  status: string;
  message: string;
  result: Array<{ contractCreator: string; txHash: string }> | string;
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
}
