const CONTROL_AND_DIRECTIONAL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const EMBEDDED_URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;

/**
 * Converts external API and on-chain labels into a single safe Telegram line.
 * Telegram messages are plain text, but URLs, line breaks, and bidi controls in
 * an attacker-controlled name can still create misleading, clickable content.
 */
export function safeDisplayText(
  value: string | null | undefined,
  maxLength = 300,
  fallback = "Unknown",
): string {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .replace(EMBEDDED_URL_PATTERN, "[link removed]")
    .replace(CONTROL_AND_DIRECTIONAL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(1, maxLength))
    .trim();
  return normalized || fallback;
}
