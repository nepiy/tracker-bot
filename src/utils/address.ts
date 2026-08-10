import { getAddress, isAddress, type Address } from "viem";

export function normalizeAddress(value: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new Error("Invalid EVM address");
  }
  return getAddress(value).toLowerCase() as Address;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
