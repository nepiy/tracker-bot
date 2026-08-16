const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const TELEGRAM_TOKEN_PATTERN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SUPABASE_SECRET_PATTERN = /\bsb_secret_[A-Za-z0-9_-]{12,}\b/g;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?role[_-]?key|password|secret)\b(\s*[:=]\s*)[^\s,;}]+/gi;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_LOG_STRING_LENGTH = 8_000;
const MAX_LOG_ARRAY_LENGTH = 50;
const MAX_LOG_OBJECT_KEYS = 100;
const MAX_LOG_DEPTH = 6;

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "set-cookie",
  "apikey",
  "api_key",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "servicerolekey",
  "service_role_key",
  "password",
  "secret",
  "token",
  "bottoken",
]);

const PRIVATE_IDENTIFIER_KEYS = new Set(["telegramid", "chatid"]);

export function redactSensitiveText(value: string): string {
  return value
    .replace(URL_PATTERN, "[REDACTED_URL]")
    .replace(TELEGRAM_TOKEN_PATTERN, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(SUPABASE_SECRET_PATTERN, "[REDACTED_SUPABASE_SECRET]")
    .replace(AUTH_HEADER_PATTERN, "$1 [REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1$2[REDACTED]")
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .slice(0, MAX_LOG_STRING_LENGTH);
}

function sanitizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  key?: string,
): unknown {
  const normalizedKey = key ? sanitizedKey(key) : "";
  if (SENSITIVE_KEYS.has(normalizedKey) || PRIVATE_IDENTIFIER_KEYS.has(normalizedKey)) {
    return "[REDACTED]";
  }
  if (normalizedKey.endsWith("url") || normalizedKey.endsWith("uri")) {
    return value === null || value === undefined ? value : "[REDACTED_URL]";
  }
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_LOG_DEPTH) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_LOG_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1, seen));
    if (value.length > MAX_LOG_ARRAY_LENGTH) items.push(`[${value.length - MAX_LOG_ARRAY_LENGTH} MORE ITEMS]`);
    return items;
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, MAX_LOG_OBJECT_KEYS);
  for (const [entryKey, entryValue] of entries) {
    result[entryKey] = sanitizeValue(entryValue, depth + 1, seen, entryKey);
  }
  if (Object.keys(value).length > MAX_LOG_OBJECT_KEYS) {
    result._truncatedKeys = Object.keys(value).length - MAX_LOG_OBJECT_KEYS;
  }
  return result;
}

export function sanitizeLogValue(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet<object>());
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message).slice(0, 1_000);
}
