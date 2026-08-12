import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { ChainClient } from "../src/blockchain/clients.js";
import { findCreatorMarketTokensOnChain } from "../src/blockchain/creatorTokens.js";
import { formatCreatorTokenHistory } from "../src/bot/commands/info.js";
import { BlockscoutExplorer } from "../src/explorers/blockscout.js";
import { EtherscanExplorer } from "../src/explorers/etherscan.js";
import type { ExplorerAdapter } from "../src/explorers/types.js";
import type { ChainConfig } from "../src/types/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const deployer = "0x0000000000000000000000000000000000000001" as Address;
const token = "0x0000000000000000000000000000000000000002" as Address;
const nonToken = "0x0000000000000000000000000000000000000003" as Address;
const txHash = `0x${"4".repeat(64)}` as const;
const chain: ChainConfig = {
  key: "base",
  name: "Base",
  chainId: 8453,
  openSeaIdentifiers: ["base"],
  rpcUrl: "https://base.example",
  explorerUrl: "https://basescan.org",
  explorerApiUrl: "https://api.etherscan.io/v2/api",
  explorerType: "etherscan",
  nativeSymbol: "ETH",
};

describe("creator token history", () => {
  it("extracts direct contract creations from Etherscan transaction history", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("action")).toBe("txlist");
      expect(url.searchParams.get("address")).toBe(deployer);
      return jsonResponse({
        status: "1",
        message: "OK",
        result: [{
          from: deployer,
          contractAddress: token,
          hash: txHash,
          isError: "0",
          timeStamp: "1786406400",
        }],
      });
    });
    const result = await new EtherscanExplorer(chain, "test-key", fetcher).getCreatedContracts(deployer);
    expect(result).toEqual({
      contracts: [{ address: token, creationTxHash: txHash, createdAt: new Date("2026-08-11T00:00:00.000Z") }],
      complete: true,
    });
  });

  it("extracts direct contract creations from paginated Blockscout history", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      items: [{
        hash: txHash,
        timestamp: "2026-08-11T00:00:00.000Z",
        status: "ok",
        from: { hash: deployer },
        created_contract: { hash: token },
      }],
      next_page_params: null,
    }));
    const blockscoutChain = {
      ...chain,
      explorerApiUrl: "https://base.blockscout.com",
      explorerType: "blockscout" as const,
    };
    const result = await new BlockscoutExplorer(blockscoutChain, undefined, fetcher).getCreatedContracts(deployer);
    expect(result.contracts).toEqual([{
      address: token,
      creationTxHash: txHash,
      createdAt: new Date("2026-08-11T00:00:00.000Z"),
    }]);
    expect(result.complete).toBe(true);
  });

  it("keeps every deployer-created ERC-20 with a DEX market and omits an empty history", async () => {
    const explorer: ExplorerAdapter = {
      getContractDeployment: async () => ({ contractCreator: deployer, creationTxHash: txHash }),
      getCreatedContracts: async () => ({
        contracts: [
          { address: token, creationTxHash: txHash, createdAt: new Date("2026-08-11T00:00:00.000Z") },
          { address: nonToken, creationTxHash: txHash, createdAt: null },
        ],
        complete: true,
      }),
    };
    const client = {
      readContract: vi.fn(async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (address === nonToken) throw new Error("not ERC-20");
        if (functionName === "name") return "Creator Coin";
        if (functionName === "symbol") return "MEME";
        if (functionName === "decimals") return 18;
        if (functionName === "totalSupply") return 1_000_000n;
        throw new Error("unexpected method");
      }),
    } as unknown as ChainClient;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain(`/tokens/v1/base/${token}`);
      return jsonResponse([{
        url: `https://dexscreener.com/base/${token}`,
        baseToken: { address: token, name: "Creator Coin", symbol: "MEME" },
        priceUsd: "0.001",
        liquidity: { usd: 25000 },
        marketCap: 1000000,
      }]);
    });
    const result = await findCreatorMarketTokensOnChain(deployer, chain, explorer, client, fetcher);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]).toMatchObject({
      address: token,
      name: "Creator Coin",
      symbol: "MEME",
      priceUsd: 0.001,
      liquidityUsd: 25000,
      marketCapUsd: 1000000,
    });

    const messages = formatCreatorTokenHistory({ deployerAddress: deployer, ...result });
    expect(messages.join("\n")).toContain("CREATOR MEMECOIN HISTORY");
    expect(messages.join("\n")).toContain("Creator Coin (MEME)");
    expect(messages.join("\n")).toContain("Market cap/FDV: $1,000,000.00");
    expect(formatCreatorTokenHistory({ deployerAddress: deployer, tokens: [], complete: true })).toEqual([]);
  });

  it("splits a long creator history without dropping older tokens", () => {
    const tokens = Array.from({ length: 40 }, (_, index) => ({
      chainId: chain.chainId,
      chainName: chain.name,
      address: `0x${(index + 10).toString(16).padStart(40, "0")}` as Address,
      name: `Creator Token ${index + 1}`,
      symbol: `MEME${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 7, 11 - (index % 10))),
      explorerUrl: `https://basescan.org/address/${token}?entry=${index + 1}`,
      marketUrl: `https://dexscreener.com/base/${token}?entry=${index + 1}`,
      priceUsd: 0.001,
      liquidityUsd: 25000,
      marketCapUsd: 1000000,
    }));
    const messages = formatCreatorTokenHistory({ deployerAddress: deployer, tokens, complete: false });
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 3_900)).toBe(true);
    expect(messages.join("\n")).toContain("40. Creator Token 40 (MEME40)");
    expect(messages[0]).toContain("additional older deployments may exist");
  });
});
