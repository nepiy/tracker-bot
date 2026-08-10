import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../src/utils/address.js";

describe("normalizeAddress", () => {
  it("stores addresses in canonical lowercase form", () => {
    expect(normalizeAddress("0x000000000000000000000000000000000000dEaD")).toBe(
      "0x000000000000000000000000000000000000dead",
    );
  });

  it("rejects non-address values", () => {
    expect(() => normalizeAddress("not-an-address")).toThrow("Invalid EVM address");
  });
});
