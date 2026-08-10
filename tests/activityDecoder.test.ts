import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { decodeActivity } from "../src/blockchain/activityDecoder.js";

const recipient = "0x0000000000000000000000000000000000000042" as Address;

describe("activity decoding", () => {
  it("recognizes a native transfer", () => {
    expect(decodeActivity({ to: recipient, value: 1n, input: "0x" }).type).toBe("native_transfer");
  });

  it("recognizes and decodes an ERC-20 transfer", () => {
    const input = encodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
      functionName: "transfer",
      args: [recipient, 100n],
    });
    const result = decodeActivity({ to: recipient, value: 0n, input });
    expect(result.type).toBe("erc20_transfer");
    expect(result.metadata.recipient).toBe(recipient);
  });

  it("recognizes router swaps", () => {
    const result = decodeActivity({ to: recipient, value: 0n, input: "0x38ed1739" });
    expect(result.type).toBe("swap");
    expect(result.metadata.label).toBe("Swap");
    expect(result.metadata.method).toBe("Exact-token swap");
  });

  it("recognizes bridge deposits", () => {
    const result = decodeActivity({ to: recipient, value: 10n, input: "0xe9e05c42" });
    expect(result.type).toBe("bridge");
    expect(result.metadata.label).toBe("Bridge");
    expect(result.metadata.method).toBe("Bridge deposit");
  });
});
