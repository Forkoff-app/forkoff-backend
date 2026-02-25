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
