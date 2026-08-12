export function compactDecimal(value: string | number): string {
  const normalized = String(value);
  if (/e/i.test(normalized)) {
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      return numeric.toLocaleString("en-US", {
        useGrouping: false,
        minimumFractionDigits: 0,
        maximumFractionDigits: 18,
      });
    }
  }
  if (!normalized.includes(".")) return normalized;
  return normalized.replace(/0+$/, "").replace(/\.$/, "");
}

export function formatUsd(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value > 0 && value < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatTokenWithUsd(
  amount: string | number,
  symbol: string,
  usdRate: string | number | null,
): string {
  const tokenLabel = `${compactDecimal(amount)} ${symbol}`;
  if (usdRate === null) return tokenLabel;
  const usdValue = Number(amount) * Number(usdRate);
  const usdLabel = formatUsd(usdValue);
  return usdLabel ? `${tokenLabel} (≈ ${usdLabel})` : tokenLabel;
}
