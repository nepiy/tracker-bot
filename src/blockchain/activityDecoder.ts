import { decodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { DecodedActivity } from "../types/index.js";
import { normalizeAddress } from "../utils/address.js";

export interface ActivityTransaction {
  to: Address | null;
  value: bigint;
  input: Hex;
}

const erc20TransferAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const erc721TransferAbi = parseAbi([
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
]);

const SWAP_SELECTORS = new Map([
  ["0x38ed1739", "Exact-token swap"],
  ["0x8803dbee", "Token-for-exact-token swap"],
  ["0x18cbafe5", "Token-to-native swap"],
  ["0x4a25d94a", "Token-for-exact-native swap"],
  ["0x7ff36ab5", "Native-to-token swap"],
  ["0xfb3bdb41", "Native-for-exact-token swap"],
  ["0x5c11d795", "Fee-on-transfer token swap"],
  ["0xb6f9de95", "Fee-on-transfer native swap"],
  ["0x791ac947", "Fee-on-transfer token-to-native swap"],
  ["0x04e45aaf", "Exact-input single swap"],
  ["0x414bf389", "Exact-input single swap"],
  ["0xb858183f", "Exact-input swap"],
  ["0xc04b8d59", "Exact-input swap"],
  ["0x3593564c", "Universal router swap"],
  ["0x415565b0", "Aggregated token swap"],
  ["0xd9627aa4", "Router token swap"],
  ["0x12aa3caf", "Aggregated swap"],
]);

const BRIDGE_SELECTORS = new Map([
  ["0xe9e05c42", "Bridge deposit"],
  ["0xb1a1a882", "Native bridge deposit"],
  ["0x9a2ac6d5", "Native bridge deposit"],
  ["0x58a997f6", "Token bridge deposit"],
  ["0x838b2520", "Token bridge deposit"],
  ["0x32b7006d", "Bridge withdrawal"],
  ["0xa3a79548", "Bridge withdrawal"],
  ["0x8340f549", "Bridge deposit"],
  ["0x7b3a3c8b", "Outbound bridge transfer"],
]);

export function decodeActivity(transaction: ActivityTransaction): DecodedActivity {
  const selector = transaction.input.slice(0, 10).toLowerCase();
  if (transaction.input === "0x" && transaction.value > 0n) {
    return { type: "native_transfer", label: "Native token transfer", metadata: { label: "SEND" } };
  }

  if (selector === "0xa9059cbb") {
    try {
      const decoded = decodeFunctionData({ abi: erc20TransferAbi, data: transaction.input });
      const [recipient, amount] = decoded.args;
      return {
        type: "erc20_transfer",
        label: "ERC-20 transfer",
        metadata: { label: "ERC-20 transfer", recipient: normalizeAddress(String(recipient)), amount: String(amount) },
      };
    } catch {
      return { type: "erc20_transfer", label: "ERC-20 transfer", metadata: { label: "ERC-20 transfer" } };
    }
  }

  if (["0x23b872dd", "0x42842e0e", "0xb88d4fde"].includes(selector)) {
    try {
      const decoded = decodeFunctionData({ abi: erc721TransferAbi, data: transaction.input });
      const args = decoded.args as readonly unknown[];
      return {
        type: "nft_transfer",
        label: "NFT transfer",
        metadata: {
          label: "NFT transfer",
          recipient: normalizeAddress(String(args[1])),
          tokenId: String(args[2]),
        },
      };
    } catch {
      return { type: "nft_transfer", label: "NFT/token transfer", metadata: { label: "NFT/token transfer" } };
    }
  }

  const swapMethod = SWAP_SELECTORS.get(selector);
  if (swapMethod) {
    return { type: "swap", label: swapMethod, metadata: { label: "Swap", method: swapMethod, selector } };
  }
  const bridgeMethod = BRIDGE_SELECTORS.get(selector);
  if (bridgeMethod) {
    return { type: "bridge", label: bridgeMethod, metadata: { label: "Bridge", method: bridgeMethod, selector } };
  }
  return {
    type: "contract_interaction",
    label: transaction.to ? "Contract interaction" : "Contract deployment",
    metadata: { label: transaction.to ? "Contract interaction" : "Contract deployment", selector },
  };
}
