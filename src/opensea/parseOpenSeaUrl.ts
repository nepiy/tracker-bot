import { UserFacingError } from "../utils/errors.js";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,199}$/i;

export function isOpenSeaSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function openSeaCollectionUrl(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!isOpenSeaSlug(normalized)) {
    throw new UserFacingError("That OpenSea collection slug is invalid.", "INVALID_SLUG");
  }
  return `https://opensea.io/collection/${encodeURIComponent(normalized)}`;
}

export function parseOpenSeaUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UserFacingError("Please send a valid OpenSea collection URL.", "INVALID_URL");
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "opensea.io" && host !== "www.opensea.io")) {
    throw new UserFacingError(
      "Only https://opensea.io/collection/... URLs are supported.",
      "INVALID_OPENSEA_URL",
    );
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "collection" || !parts[1]) {
    throw new UserFacingError(
      "Please send a collection URL like https://opensea.io/collection/fishbroker.",
      "INVALID_OPENSEA_PATH",
    );
  }

  const slug = decodeURIComponent(parts[1]).toLowerCase();
  if (!isOpenSeaSlug(slug)) {
    throw new UserFacingError("That OpenSea collection slug is invalid.", "INVALID_SLUG");
  }
  return slug;
}

export function findOpenSeaUrl(text: string): string | null {
  const match = text.match(/https:\/\/(?:www\.)?opensea\.io\/collection\/[a-z0-9-]+(?:[?#][^\s]*)?/i);
  return match?.[0] ?? null;
}
