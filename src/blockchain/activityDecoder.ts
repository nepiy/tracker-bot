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

const SWAP_SELECTORS = new Set([
  "0x38ed1739", // swapExactTokensForTokens
  "0x18cbafe5", // swapExactTokensForETH
  "0x7ff36ab5", // swapExactETHForTokens
  "0x04e45aaf", // Uniswap V3 exactInputSingle
  "0xb858183f", // Uniswap V3 exactInput
  "0x3593564c", // Uniswap Universal Router execute
]);

const BRIDGE_SELECTORS = new Set([
  "0xe9e05c42", // Optimism depositTransaction
  "0x8340f549", // common bridge deposit
  "0x7b3a3c8b", // common bridge outbound transfer
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

  if (SWAP_SELECTORS.has(selector)) {
    return { type: "swap", label: "Swap", metadata: { label: "Swap", selector } };
  }
  if (BRIDGE_SELECTORS.has(selector)) {
    return { type: "bridge", label: "Bridge interaction", metadata: { label: "Bridge", selector } };
  }
  return {
    type: "contract_interaction",
    label: transaction.to ? "Contract interaction" : "Contract deployment",
    metadata: { label: transaction.to ? "Contract interaction" : "Contract deployment", selector },
  };
}
