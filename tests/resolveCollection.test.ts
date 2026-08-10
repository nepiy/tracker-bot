import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config/env.js";
import { resolveOpenSeaCollection } from "../src/opensea/resolveCollection.js";

const env = {
  OPENSEA_API_KEY: "test-key",
  ETHEREUM_RPC_URL: "https://eth.example",
  BASE_RPC_URL: "https://base.example",
  ROBINHOOD_RPC_URL: "https://robinhood.example",
} as AppEnv;

describe("OpenSea collection resolution", () => {
  it("uses the documented v2 response contract and resolves Robinhood", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      collection: "fishbroker",
      name: "FishBroker",
      contracts: [{
        address: "0x0000000000000000000000000000000000000042",
        chain: "robinhood",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(resolveOpenSeaCollection(
      "https://opensea.io/collection/fishbroker",
      env,
      fetcher,
    )).resolves.toEqual({
      name: "FishBroker",
      slug: "fishbroker",
      chain: "robinhood",
      chainId: 4663,
      contractAddress: "0x0000000000000000000000000000000000000042",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.opensea.io/api/v2/collections/fishbroker",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "test-key" }) }),
    );
  });

  it("turns a documented 404 into a clear user error", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(resolveOpenSeaCollection(
      "https://opensea.io/collection/missing",
      env,
      fetcher,
    )).rejects.toThrow("couldn't find");
  });
});
