import { createHash, randomBytes } from "node:crypto";

/**
 * Generates a single-use opaque token. The raw value is returned once (to embed
 * in an email link) and only its sha256 hash is persisted, so a database leak
 * cannot reveal usable tokens.
 */
export function createToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function expiryFromNow(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}

/** A stored token record is valid only if unused and not past its expiry. */
export function isTokenUsable(record: { usedAt: Date | null; expiresAt: Date }): boolean {
  return record.usedAt === null && record.expiresAt.getTime() > Date.now();
}
