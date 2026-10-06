import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";

// Rate-limit key material for template routes (security review B1, 2026-10-06).
//
// Keys held by @fastify/rate-limit's in-memory LRU must never contain a raw
// client IP: the store is process memory, not a PII sink, and keys can surface
// in heap dumps or future debug output. Each key is therefore a truncated
// SHA-256 over a process-lifetime random salt. The salt is not a secrecy
// control (an in-process reader could pair it with traffic anyway); it keeps
// keys unreproducible across restarts/instances so nothing derived from them
// can be correlated into logs or analytics later. No IP is stored or logged
// anywhere in this feature.
//
// Authenticated routes key on request.user.sub — the verified JWT subject
// produced by app.authenticate (signature + claims + tokenVersion). keyGenerator
// runs in the preHandler hook *after* that preHandler (the plugin appends its
// handler to the route's preHandler array), so the payload here is already
// validated. Nothing decodes a JWT on its own path.
const RATE_LIMIT_KEY_SALT = randomBytes(16);

const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isShareTokenShaped(value: unknown): value is string {
  return typeof value === "string" && SHARE_TOKEN_PATTERN.test(value);
}

function keyedHash(parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(RATE_LIMIT_KEY_SALT);
  for (const part of parts) hash.update("\u0000").update(part);
  return hash.digest("base64url").slice(0, 22);
}

function requestSocketOrClientIp(request: FastifyRequest): string {
  // request.ip already honors Fastify's trustProxy narrowing: with
  // TRUST_PROXY=off it is the socket peer (spoof-proof XFF is ignored);
  // with TRUST_PROXY=loopback it is the client address only when the
  // immediate hop was a loopback proxy that supplied X-Forwarded-For.
  return request.ip || "unknown";
}

/**
 * Per-(client, token) anonymous bucket. Malformed tokens share one cheap
 * bucket so probe floods cannot mint unbounded store keys.
 */
export function shareTokenKey(request: FastifyRequest): string {
  const token = (request.params as { token?: unknown } | undefined)?.token;
  if (!isShareTokenShaped(token)) return "share:malformed";
  return `share:t:${keyedHash([requestSocketOrClientIp(request), token])}`;
}

/**
 * Per-client sweep bucket across the public share surface. Only meaningful
 * when TRUST_PROXY=loopback has been enabled after the proxy chain was
 * verified; otherwise request.ip is the shared proxy socket and a per-client
 * cap would cap everyone, so the caller must skip this layer (see routes).
 */
export function shareClientKey(request: FastifyRequest): string {
  return `share:c:${keyedHash([requestSocketOrClientIp(request)])}`;
}

/**
 * G1 backstop key for the authenticated /templates* surface: a salted hash of
 * the already trustProxy-narrowed request.ip (never a raw IP). The coarse
 * guard runs in onRequest — *before* authenticate — so it bounds the DB cost
 * of auth-failure paths (signed-but-revoked 401, unverified-email 403) that
 * the post-auth verified-sub limiter structurally cannot see. With
 * TRUST_PROXY=off the socket is the shared proxy address, i.e. this is one
 * aggregated instance bucket (an availability tradeoff documented in
 * docs/templates-security-20261006.md §G1, not a per-client claim); with the
 * verified loopback gate it becomes per-client capacity automatically.
 */
export function authSurfaceKey(request: FastifyRequest): string {
  return `templates:surface:${keyedHash([requestSocketOrClientIp(request)])}`;
}

/**
 * Verified-user key for authenticated template routes. If this ever runs
 * without a prior successful authenticate, failing closed (401) is preferred
 * over inventing a shared bucket that could poison per-user limits.
 */
export function verifiedUserKey(request: FastifyRequest): string {
  const sub = (request.user as { sub?: unknown } | undefined)?.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw Object.assign(new Error("Invalid token"), { statusCode: 401 });
  }
  return `templates:u:${sub}`;
}
