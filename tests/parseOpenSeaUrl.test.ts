import { describe, expect, it } from "vitest";
import { findOpenSeaUrl, parseOpenSeaUrl } from "../src/opensea/parseOpenSeaUrl.js";

describe("parseOpenSeaUrl", () => {
  it("extracts and normalizes a collection slug", () => {
    expect(parseOpenSeaUrl("https://opensea.io/collection/FishBroker")).toBe("fishbroker");
  });

  it("allows the www host and harmless query strings", () => {
    expect(parseOpenSeaUrl("https://www.opensea.io/collection/fishbroker?tab=items")).toBe("fishbroker");
  });

  it.each([
    "http://opensea.io/collection/fishbroker",
    "https://evil.example/collection/fishbroker",
    "https://opensea.io/assets/fishbroker",
    "https://opensea.io/collection/fishbroker/extra",
  ])("rejects malformed or unsafe URL %s", (url) => {
    expect(() => parseOpenSeaUrl(url)).toThrow();
  });

  it("finds a collection URL in a Telegram message", () => {
    expect(findOpenSeaUrl("track https://opensea.io/collection/fishbroker please")).toBe(
      "https://opensea.io/collection/fishbroker",
    );
  });
});
