import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { templateBlueprintSchema, templateWriteSchema, templateUpdateSchema, templatePublishSchema } from "@living-cost-manager/shared";

import { shareClientKey, shareTokenKey, verifiedUserKey } from "../services/template-rate-limit.js";

const params = z.object({ id: z.string().min(1).max(100) }).strict();
const shareParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const SIZE_LIMIT = 100 * 1024;
const QUOTA = 20;

// Test seam for expiry boundaries (injected clocks beat sleeps). Expiration is
// a minute-level product promise, so re-reading the clock between a read and a
// conditional purge is safe; there is no same-millisecond invariant.
export const templateClock = { now: (): Date => new Date() };

// B1 (security review 2026-10-06): limiter wiring for authenticated template
// traffic. `hook: "preHandler"` is what makes the ordering correct —
// @fastify/rate-limit appends its hook handler AFTER the route's own
// preHandler array entry (its onRoute handling pushes onto routeOptions), so
// keyGenerator only ever sees request.user after app.authenticate /
// app.requireVerifiedEmail succeeded: signature + iss/aud + tokenVersion were
// checked against the DB. Nothing here decodes an unverified token. Requests
// that fail authentication short-circuit at 401/403 before the limiter, so
// invalid or expired tokens cannot consume a legitimate user's budget.
// Keys are `templates:u:<sub>` — no IPs in authenticated buckets — and
// `cache` bounds the route's in-memory LRU store for dynamic user keys.
const AUTH_RATE_CONFIG = {
  max: 60,
  timeWindow: "1 minute",
  hook: "preHandler",
  cache: 5000,
  keyGenerator: verifiedUserKey
} as const;

// A share is "published" only while it exists, was not revoked and has not
// expired. revokedAt stays in the contract only for legacy rows written before
// revoke started deleting the share (see the DELETE /share handler).
function isPublishedShare(share: { revokedAt: Date | null; expiresAt: Date } | null): boolean {
  return !!share && share.revokedAt === null && share.expiresAt.getTime() > templateClock.now().getTime();
}

// N1 owner-side sweep: published copies that are expired or carry a legacy
// revokedAt mark. The private draft is never part of this condition. Expired
// rows match by expiry only (a concurrent republish moves expiresAt to the
// future), revoked rows can only be legacy data (new code deletes on revoke).
const staleSharePurgeWhere = (userId: string, now: Date) => ({
  template: { userId },
  OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }]
});

// B4: every guarded write locks the owning User row FOR UPDATE and checks the
// returned row count before writing. If the account vanished between the
// preHandler's tokenVersion lookup and this transaction, the guard turns the
// would-be FK violation (P2003 → 500) into a consistent 401 "Invalid token"
// (same semantics as app.authenticate for a user row that no longer exists).
async function lockUser(app: FastifyInstance, tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const rows = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  if (!Array.isArray(rows) || rows.length === 0) throw app.httpErrors.unauthorized("Invalid token");
}

export async function templateRoutes(app: FastifyInstance) {
  const env = app.appEnv;

  // Fresh option objects per registration: @fastify/rate-limit's onRoute
  // handling rewrites routeOptions.preHandler, so the literal must never be
  // shared across route registrations.
  const auth = () => ({ preHandler: app.authenticate, bodyLimit: SIZE_LIMIT, config: { rateLimit: { ...AUTH_RATE_CONFIG } } });
  const verified = () => ({ preHandler: app.requireVerifiedEmail, bodyLimit: SIZE_LIMIT, config: { rateLimit: { ...AUTH_RATE_CONFIG } } });

  // Anonymous share reads — two layers, and neither stores a raw IP: any
  // bucket key is a salted one-way hash (see template-rate-limit.ts).
  //  1) token-scoped 30/min: pre-fix, every customer behind the nginx socket
  //     shared one bucket, so a single burst blocked all public reads. Now
  //     the burst (client IP as resolved under the env-gated proxy trust, plus
  //     the looked-up token) is isolated per client and per share; malformed
  //     probe tokens collapse into one cheap shared bucket.
  //  2) sweep layer, env-conditional and honest about what the instance can
  //     actually observe: with TRUST_PROXY=loopback (only after the read-only
  //     ops verification in docs/templates-security-20261006.md) each client
  //     gets its own 90/min across all shares; with the default "off" state
  //     request.ip is the proxy socket for everyone, so a per-IP claim would be
  //     fake — instead one coarse instance-wide bucket (120/min) bounds
  //     rotating-token floods without pretending to identify clients.
  // Implemented via createRateLimit() in a route-level onRequest hook so the
  // sweep layer can branch on the env gate; config.rateLimit=false keeps the
  // plugin's own route hook from double-counting.
  const tokenScopedShareLimit = app.createRateLimit({ keyGenerator: shareTokenKey, max: 30, timeWindow: "1 minute" });
  const sweepShareLimit =
    env.TRUST_PROXY === "loopback"
      ? app.createRateLimit({ keyGenerator: shareClientKey, max: 90, timeWindow: "1 minute" })
      : app.createRateLimit({ keyGenerator: () => "share:instance", max: 120, timeWindow: "1 minute" });
  const shareGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    const checks = await Promise.all([tokenScopedShareLimit(request), sweepShareLimit(request)]);
    for (const check of checks) {
      if ("isExceeded" in check && check.isExceeded) {
        reply.header("retry-after", String(Math.max(1, Math.ceil(check.ttl / 1000))));
        throw app.httpErrors.tooManyRequests("Share read limit reached; try again in about a minute");
      }
    }
  };

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store").header("X-Robots-Tag", "noindex, nofollow");
  });
  app.get("/templates", auth(), async request => {
    // N1 (privacy review): owner-side opportunistic sweep of the requester's
    // own stale published copies before listing. No cron: reads by the owner
    // (and account/template cascades) keep the rows bounded. The delete is
    // conditional (expiry/legacy-revocation only) and never touches drafts.
    await app.prisma.budgetTemplateShare.deleteMany({ where: staleSharePurgeWhere(request.user.sub, templateClock.now()) });
    const entries = await app.prisma.budgetTemplate.findMany({ where: { userId: request.user.sub }, orderBy: { createdAt: "desc" }, take: QUOTA, include: { share: true } });
    return entries.map(entry => ({ id: entry.id, revision: entry.revision, blueprint: templateBlueprintSchema.parse(entry.blueprint), published: isPublishedShare(entry.share) }));
  });
  app.post("/templates", verified(), async (request, reply) => {
    const parsed = templateWriteSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest("Invalid blueprint; financial fields are not allowed");
    const entry = await app.prisma.$transaction(async tx => {
      await lockUser(app, tx, request.user.sub);
      if (await tx.budgetTemplate.count({ where: { userId: request.user.sub } }) >= QUOTA) throw app.httpErrors.conflict("Template quota (20) reached");
      return tx.budgetTemplate.create({ data: { userId: request.user.sub, blueprint: parsed.data.blueprint } });
    });
    return reply.code(201).send({ id: entry.id, revision: entry.revision, blueprint: entry.blueprint, published: false });
  });
  app.put("/templates/:id", verified(), async request => {
    const id = params.safeParse(request.params);
    const input = templateUpdateSchema.safeParse(request.body);
    if (!id.success || !input.success) throw app.httpErrors.badRequest("Invalid template");
    return app.prisma.$transaction(async tx => {
      await lockUser(app, tx, request.user.sub);
      const entry = await tx.budgetTemplate.findFirst({ where: { id: id.data.id, userId: request.user.sub }, include: { share: true } });
      if (!entry) throw app.httpErrors.notFound("Template not found");
      if (entry.revision !== input.data.revision) throw app.httpErrors.conflict("Template changed; reload before saving");
      const updated = await tx.budgetTemplate.update({ where: { id: entry.id }, data: { blueprint: input.data.blueprint, revision: { increment: 1 } } });
      // C10: response is symmetric with POST/GET. Draft edits never rewrite the
      // pinned publication, so `published` reports the still-active share, and
      // the share token (a capability) never appears outside the publish call.
      return { id: updated.id, revision: updated.revision, blueprint: updated.blueprint, published: isPublishedShare(entry.share) };
    });
  });
  app.post("/templates/:id/publish", verified(), async request => {
    const id = params.safeParse(request.params);
    const input = templatePublishSchema.safeParse(request.body);
    if (!id.success || !input.success) throw app.httpErrors.badRequest("Review and rights confirmation required");
    return app.prisma.$transaction(async tx => {
      await lockUser(app, tx, request.user.sub);
      const entry = await tx.budgetTemplate.findFirst({ where: { id: id.data.id, userId: request.user.sub } });
      if (!entry) throw app.httpErrors.notFound("Template not found");
      if (entry.revision !== input.data.revision) throw app.httpErrors.conflict("Review the current saved version before publishing");
      // Same owner-scoped sweep, inside the serialized publish path.
      await tx.budgetTemplateShare.deleteMany({ where: staleSharePurgeWhere(request.user.sub, templateClock.now()) });
      const blueprint = templateBlueprintSchema.parse(entry.blueprint);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(templateClock.now().getTime() + 90 * 86400000);
      await tx.budgetTemplateShare.upsert({ where: { templateId: entry.id }, create: { templateId: entry.id, token, blueprint, expiresAt }, update: { token, blueprint, expiresAt, revokedAt: null } });
      return { token, expiresAt: expiresAt.toISOString() };
    });
  });
  app.delete("/templates/:id/share", auth(), async (request, reply) => {
    const input = params.safeParse(request.params);
    if (!input.success) throw app.httpErrors.badRequest("Invalid template");
    await app.prisma.$transaction(async tx => {
      await lockUser(app, tx, request.user.sub);
      const entry = await tx.budgetTemplate.findFirst({ where: { id: input.data.id, userId: request.user.sub } });
      if (!entry) throw app.httpErrors.notFound("Template not found");
      // N1 (privacy default): an explicit revoke deletes the published copy
      // outright (token + text removed inside this owner transaction) instead
      // of retaining it until account deletion. deleteMany (not updateMany):
      // zero rows is a no-op, so a replayed revoke stays 204/idempotent for
      // clients and a concurrent republish can never be "half-revoked".
      // The private draft survives — only the public publication is withdrawn.
      await tx.budgetTemplateShare.deleteMany({ where: { templateId: entry.id } });
    });
    return reply.code(204).send();
  });
  app.delete("/templates/:id", auth(), async (request, reply) => {
    const input = params.safeParse(request.params);
    if (!input.success) throw app.httpErrors.badRequest("Invalid template");
    await app.prisma.$transaction(async tx => {
      await lockUser(app, tx, request.user.sub);
      const entry = await tx.budgetTemplate.findFirst({ where: { id: input.data.id, userId: request.user.sub } });
      if (!entry) throw app.httpErrors.notFound("Template not found");
      await tx.budgetTemplate.delete({ where: { id: entry.id } });
    });
    return reply.code(204).send();
  });
  app.get("/template-shares/:token", { config: { rateLimit: false }, onRequest: [shareGuard] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const input = shareParams.safeParse(request.params);
    if (!input.success) throw app.httpErrors.notFound("Share unavailable");
    const entry = await app.prisma.budgetTemplateShare.findFirst({ where: { token: input.data.token } });
    const now = templateClock.now();
    if (!entry || entry.revokedAt !== null || entry.expiresAt.getTime() <= now.getTime()) {
      if (entry && entry.revokedAt === null) {
        // Opportunistic expiry sweep on public reads: conditioned on the exact
        // token AND still-expired state, so a concurrent republish (which
        // rotates the token) can never be deleted here. Legacy revoked rows
        // are left for the owner-side sweep to keep public reads from touching
        // revocation state. Best-effort physical cleanup — the logical 404
        // above is what readers observe; no cron, no promised deletion day.
        await app.prisma.budgetTemplateShare.deleteMany({ where: { token: input.data.token, revokedAt: null, expiresAt: { lte: templateClock.now() } } });
      }
      throw app.httpErrors.notFound("Share unavailable");
    }
    // Explicit public shape, no spreading ORM rows or ownership metadata.
    return { blueprint: templateBlueprintSchema.parse(entry.blueprint) };
  });
}
