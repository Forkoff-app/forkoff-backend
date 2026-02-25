/**
 * Log sanitization utilities.
 * Truncate/mask identifiers to prevent PII leakage in production logs.
 */

/** Truncate a UUID or identifier for safe logging: "550e8400-..." -> "550e84...440000" */
export function truncateId(id: string | undefined | null, prefixLen = 6, suffixLen = 6): string {
  if (!id) return '[none]';
  if (id.length <= prefixLen + suffixLen + 3) return id;
  return `${id.substring(0, prefixLen)}...${id.substring(id.length - suffixLen)}`;
}

/** Mask a Stripe ID for logging: "cus_abc123def456" -> "cus_abc...456" */
export function maskStripeId(id: string | undefined | null): string {
  if (!id) return '[none]';
  const parts = id.split('_');
  if (parts.length < 2) return truncateId(id);
  const prefix = parts[0];
  const value = parts.slice(1).join('_');
  if (value.length <= 6) return id;
  return `${prefix}_${value.substring(0, 3)}...${value.substring(value.length - 3)}`;
}

/** Mask a voucher/referral code: "ABCD1234" -> "AB****34" */
export function maskCode(code: string | undefined | null): string {
  if (!code) return '[none]';
  if (code.length <= 4) return '****';
  return `${code.substring(0, 2)}****${code.substring(code.length - 2)}`;
}
