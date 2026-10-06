import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { TEMPLATE_SCENARIOS } from "@living-cost-manager/shared";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { templateClock } from "../src/routes/templates.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

// Security-review regression tests (B1 rate-limit keying, B4 vanished-account
// guard, N1 revoke/expiry privacy, C10 PUT symmetry). Rate enforcement is
// exercised on apps built with NODE_ENV development because the test env
// intentionally allows all traffic through (see app.ts allowList) — same
// pattern as the pre-existing public rate limit test in templates.test.ts.

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: "template-security-test-secret-at-least-32" });
const app = await buildApp({ prisma, env, logger: false });
const blueprint = TEMPLATE_SCENARIOS[0];
const userIds: string[] = [];
const realNow = templateClock.now;

const bearer = (id: string) => app.signTokens({ id, tokenVersion: 0 }).accessToken;
async function makeUser(verified = true): Promise<string> {
  const user = await prisma.user.create({ data: { email: `template-sec-${crypto.randomUUID()}@example.com`, name: "SecTest", passwordHash: "synthetic", ...(verified ? { emailVerifiedAt: new Date() } : {}) } });
  userIds.push(user.id);
  return user.id;
}
async function gated(trustProxy?: "off" | "loopback") {
  return buildApp({ prisma, logger: false, env: loadEnv({ NODE_ENV: "development", DATABASE_URL: databaseUrl, JWT_SECRET: "template-security-test-secret-at-least-32", ...(trustProxy ? { TRUST_PROXY: trustProxy } : {}) }) });
}
function newToken(): string {
  return randomBytes(32).toString("base64url");
}
async function publishShare(userId: string): Promise<{ templateId: string; token: string }> {
  const entry = await prisma.budgetTemplate.create({ data: { userId, blueprint } });
  const token = newToken();
  await prisma.budgetTemplateShare.create({ data: { templateId: entry.id, token, blueprint, expiresAt: new Date(Date.now() + 86400000) } });
  return { templateId: entry.id, token };
}

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  templateClock.now = realNow;
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  await prisma.$disconnect();
});

describe("B1: rate limiting is keyed per verified user, never on a shared proxy IP", () => {
  test("pre-auth backstop bounds revoked-token DB work across methods and IDs", async () => {
    const limited = await gated();
    const victim = await makeUser();
    const token = bearer(victim);
    await prisma.user.update({ where: { id: victim }, data: { tokenVersion: 1 } });
    const lookup = vi.spyOn(prisma.user, "findUnique");
    try {
      for (let i = 0; i < 300; i++) {
        const response = await limited.inject({ method: i % 2 ? "DELETE" : "GET", url: i % 2 ? `/templates/probe-${i}` : "/templates", headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode).toBe(401);
      }
      expect(lookup).toHaveBeenCalledTimes(300);
      const denied = await limited.inject({ method: "POST", url: "/templates/probe/publish", headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "9.9.9.9" }, payload: {} });
      expect(denied.statusCode).toBe(429);
      expect(lookup).toHaveBeenCalledTimes(300);
      for (const value of [victim, token, "127.0.0.1", "templates:surface:"]) expect(denied.body).not.toContain(value);
    } finally { lookup.mockRestore(); await limited.close(); }
  }, 30_000);

  test("pre-auth backstop caps unverified-email and malformed-token traffic", async () => {
    const limited = await gated();
    const user = await makeUser(false);
    const token = bearer(user);
    const lookup = vi.spyOn(prisma.user, "findUnique");
    try {
      for (let i = 0; i < 300; i++) {
        const badSignature = i % 2 === 0;
        const response = await limited.inject({ method: "POST", url: "/templates", headers: { authorization: `Bearer ${badSignature ? "garbage.token.here" : token}` }, payload: { blueprint } });
        expect(response.statusCode).toBe(badSignature ? 401 : 403);
      }
      const before = lookup.mock.calls.length;
      expect(before).toBeGreaterThan(0);
      expect(before).toBeLessThanOrEqual(300);
      expect((await limited.inject({ method: "POST", url: "/templates", headers: { authorization: `Bearer ${token}` }, payload: { blueprint } })).statusCode).toBe(429);
      expect(lookup.mock.calls.length).toBe(before);
    } finally { lookup.mockRestore(); await limited.close(); }
  }, 30_000);

  test("two legitimate authenticated users do not share a bucket (pre-fix: all customers on one key)", async () => {
    const limited = await gated();
    try {
      const a = await makeUser();
      const b = await makeUser();
      let last = 0;
      for (let i = 0; i < 61; i++) last = (await limited.inject({ method: "GET", url: "/templates", headers: { authorization: `Bearer ${bearer(a)}` } })).statusCode;
      expect(last).toBe(429); // A exhausted its own 60/min
      const other = await limited.inject({ method: "GET", url: "/templates", headers: { authorization: `Bearer ${bearer(b)}` } });
      expect(other.statusCode).toBe(200); // B unaffected despite the identical socket IP
      const body = await limited.inject({ method: "GET", url: "/templates", headers: { authorization: `Bearer ${bearer(a)}` } });
      expect(body.statusCode).toBe(429);
      // Bucket keys and identities must not leak into the error payload.
      expect(body.body).not.toContain(a);
      expect(body.body).not.toContain("templates:u:");
      expect(body.body).not.toContain("127.0.0.1");
    } finally { await limited.close(); }
  }, 30_000);

  test("invalid, garbage or version-bumped tokens cannot consume a legitimate user's budget", async () => {
    const limited = await gated();
    try {
      const victim = await makeUser();
      const token = bearer(victim);
      // 80 hostile requests with garbage auth headers (never reach keyGenerator
      // because authenticate fails first), then with a revoked-but-well-formed
      // token (tokenVersion bumped). Neither may touch the victim's bucket.
      for (let i = 0; i < 40; i++) expect((await limited.inject({ method: "GET", url: "/templates", headers: { authorization: "Bearer garbage.token.here" } })).statusCode).toBe(401);
      await prisma.user.update({ where: { id: victim }, data: { tokenVersion: 5 } });
      for (let i = 0; i < 40; i++) expect((await limited.inject({ method: "GET", url: "/templates", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
      await prisma.user.update({ where: { id: victim }, data: { tokenVersion: 0 } });
      const after = await limited.inject({ method: "GET", url: "/templates", headers: { authorization: `Bearer ${token}` } });
      expect(after.statusCode).toBe(200); // full 60/min budget still available
    } finally { await limited.close(); }
  }, 30_000);

  test("anonymous share bursts are isolated per client+token; spoofed XFF cannot partition-bypass or poison others (TRUST_PROXY=off default)", async () => {
    const limited = await gated();
    try {
      const owner = await makeUser();
      const first = await publishShare(owner);
      const second = await publishShare(owner);
      let last = 0;
      for (let i = 0; i < 31; i++) last = (await limited.inject({ method: "GET", url: `/template-shares/${first.token}` })).statusCode;
      expect(last).toBe(429); // 30/min burst cap on this (socket, token)
      // Same socket, spoofed XFF: ignored while untrusted -> still limited, no bypass.
      expect((await limited.inject({ method: "GET", url: `/template-shares/${first.token}`, headers: { "x-forwarded-for": "9.9.9.9" } })).statusCode).toBe(429);
      // A different share is NOT collateral damage of one share's burst.
      expect((await limited.inject({ method: "GET", url: `/template-shares/${second.token}` })).statusCode).toBe(200);
      // Malformed probes collapse into one cheap bucket instead of minting keys.
      let malformed = 0;
      for (let i = 0; i < 31; i++) malformed = (await limited.inject({ method: "GET", url: "/template-shares/not-a-valid-token-shape" })).statusCode;
      expect(malformed).toBe(429);
      expect((await limited.inject({ method: "GET", url: `/template-shares/${second.token}` })).statusCode).toBe(200);
      const denied = await limited.inject({ method: "GET", url: `/template-shares/${first.token}` });
      expect(denied.body).not.toContain(first.token); // no capability echo in the 429 body
    } finally { await limited.close(); }
  }, 30_000);

  test("with verified loopback proxy trust, distinct client IPs get distinct buckets; untrusted direct sockets do not", async () => {
    const limited = await gated("loopback");
    try {
      const owner = await makeUser();
      const share = await publishShare(owner);
      const clientOne = { method: "GET" as const, url: `/template-shares/${share.token}`, remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.7" } };
      const clientTwo = { ...clientOne, headers: { "x-forwarded-for": "203.0.113.8" } };
      let last = 0;
      for (let i = 0; i < 31; i++) last = (await limited.inject(clientOne)).statusCode;
      expect(last).toBe(429); // one anonymous client's burst...
      expect((await limited.inject(clientTwo)).statusCode).toBe(200); // ...cannot block another's reads
      // A direct (non-loopback) socket is its own authority: XFF spoofing there
      // neither buys fresh buckets nor avoids the cap for the real socket.
      const direct = { method: "GET" as const, url: `/template-shares/${share.token}`, remoteAddress: "198.51.100.9", headers: { "x-forwarded-for": "9.9.9.9" } };
      let directLast = 0;
      for (let i = 0; i < 31; i++) directLast = (await limited.inject(direct)).statusCode;
      expect(directLast).toBe(429);
      expect((await limited.inject({ ...direct, headers: { "x-forwarded-for": "8.8.8.8" } })).statusCode).toBe(429); // spoof swap: same socket bucket
    } finally { await limited.close(); }
  }, 30_000);
});

describe("B4: vanished accounts fail as 401, never as FK 500", () => {
  test("valid JWT for an already-deleted account cannot create templates", async () => {
    const doomed = await makeUser();
    const token = bearer(doomed);
    await prisma.user.delete({ where: { id: doomed } });
    const created = await app.inject({ method: "POST", url: "/templates", headers: { authorization: `Bearer ${token}` }, payload: { blueprint } });
    expect(created.statusCode).toBe(401);
    expect(await prisma.budgetTemplate.count({ where: { userId: doomed } })).toBe(0);
  });

  test("account deleted while the create transaction waits on the row lock returns 401, not P2003 500", async () => {
    const doomed = await makeUser();
    const token = bearer(doomed);
    // Hold the user-row lock, fire the create (its FOR UPDATE guard queues
    // behind the lock), delete the account inside the holder, release. Pre-fix
    // the queued transaction proceeded to a budgetTemplate.create for a user
    // row that no longer exists -> FK P2003 -> 500.
    const responsePromise = (async () => {
      let release!: () => void;
      const locked = new Promise<void>(resolve => { release = resolve; });
      const tx = prisma.$transaction(async txc => {
        await txc.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${doomed} FOR UPDATE`;
        release();
        await new Promise(resolve => setTimeout(resolve, 150));
        await txc.user.delete({ where: { id: doomed } });
      });
      await locked;
      const response = await app.inject({ method: "POST", url: "/templates", headers: { authorization: `Bearer ${token}` }, payload: { blueprint } });
      await tx;
      return response;
    })();
    const response = await responsePromise;
    expect(response.statusCode).toBe(401);
    expect(response.statusCode).not.toBe(500);
    expect(await prisma.budgetTemplate.count({ where: { userId: doomed } })).toBe(0);
  }, 20_000);
});

describe("N1: revoke deletes the publication; expired copies are swept; drafts persist", () => {
  test("explicit revoke removes token+text; replays are idempotent 204; public replays 404", async () => {
    const owner = await makeUser();
    const token = bearer(owner);
    const entry = await prisma.budgetTemplate.create({ data: { userId: owner, blueprint } });
    const shareToken = newToken();
    await prisma.budgetTemplateShare.create({ data: { templateId: entry.id, token: shareToken, blueprint, expiresAt: new Date(Date.now() + 86400000) } });
    expect((await app.inject({ method: "GET", url: `/template-shares/${shareToken}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/templates/${entry.id}/share`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(204);
    expect(await prisma.budgetTemplateShare.count({ where: { templateId: entry.id } })).toBe(0); // no token/blueprint retention after revoke
    expect((await app.inject({ method: "DELETE", url: `/templates/${entry.id}/share`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(204); // replay idempotent
    expect((await app.inject({ method: "GET", url: `/template-shares/${shareToken}` })).statusCode).toBe(404);
    expect(await prisma.budgetTemplate.count({ where: { id: entry.id } })).toBe(1); // draft untouched by revoke
  });

  test("expiry boundary is deterministic under an injected clock: served at T-1ms, gone at T, physically swept", async () => {
    const owner = await makeUser();
    const token = bearer(owner);
    const entry = await prisma.budgetTemplate.create({ data: { userId: owner, blueprint } });
    const base = new Date("2026-10-06T00:00:00.000Z");
    const expiry = base.getTime() + 90 * 86400000;
    let now = base.getTime();
    templateClock.now = () => new Date(now);
    const published = await app.inject({ method: "POST", url: `/templates/${entry.id}/publish`, headers: { authorization: `Bearer ${token}` }, payload: { revision: 1, reviewed: true, rightsConfirmed: true } });
    expect(published.statusCode).toBe(200);
    expect(published.json().expiresAt).toBe(new Date(expiry).toISOString()); // expiry derived from the injected clock
    const shareToken = published.json().token as string;
    now = expiry - 1;
    expect((await app.inject({ method: "GET", url: `/template-shares/${shareToken}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/templates", headers: { authorization: `Bearer ${token}` } })).json()[0].published).toBe(true);
    now = expiry; // exact-now boundary counts as expired
    expect((await app.inject({ method: "GET", url: `/template-shares/${shareToken}` })).statusCode).toBe(404);
    expect(await prisma.budgetTemplateShare.count({ where: { templateId: entry.id } })).toBe(0); // opportunistic physical sweep on public read
    expect(await prisma.budgetTemplate.count({ where: { id: entry.id } })).toBe(1); // draft persists
    templateClock.now = realNow;
  });

  test("owner list sweeps legacy revoked and expired copies but never the fresh publication or drafts", async () => {
    const owner = await makeUser();
    const token = bearer(owner);
    const stale = await prisma.budgetTemplate.create({ data: { userId: owner, blueprint } });
    const legacyRevoked = await prisma.budgetTemplate.create({ data: { userId: owner, blueprint } });
    const fresh = await prisma.budgetTemplate.create({ data: { userId: owner, blueprint } });
    await prisma.budgetTemplateShare.createMany({ data: [
      { templateId: stale.id, token: newToken(), blueprint, expiresAt: new Date(Date.now() - 1000) }, // expired
      { templateId: legacyRevoked.id, token: newToken(), blueprint, expiresAt: new Date(Date.now() + 86400000), revokedAt: new Date(Date.now() - 1000) }, // pre-delete-on-revoke legacy row
      { templateId: fresh.id, token: newToken(), blueprint, expiresAt: new Date(Date.now() + 86400000) }
    ] });
    // Public read of a revoked-legacy token must not physically sweep it (owner-side job only).
    const legacyToken = (await prisma.budgetTemplateShare.findFirstOrThrow({ where: { templateId: legacyRevoked.id } })).token;
    expect((await app.inject({ method: "GET", url: `/template-shares/${legacyToken}` })).statusCode).toBe(404);
    expect(await prisma.budgetTemplateShare.count({ where: { templateId: legacyRevoked.id } })).toBe(1);
    const listed = await app.inject({ method: "GET", url: "/templates", headers: { authorization: `Bearer ${token}` } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().find((e: { id: string }) => e.id === fresh.id).published).toBe(true);
    expect(await prisma.budgetTemplateShare.count({ where: { templateId: { in: [stale.id, legacyRevoked.id] } } })).toBe(0);
    expect(await prisma.budgetTemplateShare.count({ where: { templateId: fresh.id } })).toBe(1);
    expect(await prisma.budgetTemplate.count({ where: { userId: owner } })).toBe(3); // drafts all intact
  });

  test("republished share survives an old-token expiry replay: rotation makes the conditional sweep a no-op on the fresh row", async () => {
    const owner = await makeUser();
    const token = bearer(owner);
    const base = new Date("2026-10-06T00:00:00.000Z");
    let now = base.getTime();
    templateClock.now = () => new Date(now);
    const entry = await prisma.budgetTemplate.create({ data: { userId: owner, blueprint } });
    const first = (await app.inject({ method: "POST", url: `/templates/${entry.id}/publish`, headers: { authorization: `Bearer ${token}` }, payload: { revision: 1, reviewed: true, rightsConfirmed: true } })).json();
    now = base.getTime() + 2 * 90 * 86400000; // deep past the first window
    const republished = await app.inject({ method: "POST", url: `/templates/${entry.id}/publish`, headers: { authorization: `Bearer ${token}` }, payload: { revision: 1, reviewed: true, rightsConfirmed: true } });
    expect(republished.statusCode).toBe(200);
    const second = republished.json();
    expect(second.token).not.toBe(first.token);
    expect((await app.inject({ method: "GET", url: `/template-shares/${first.token}` })).statusCode).toBe(404); // old token: row itself is gone via rotation
    expect((await app.inject({ method: "GET", url: `/template-shares/${second.token}` })).statusCode).toBe(200); // fresh row readable
    expect(await prisma.budgetTemplateShare.count({ where: { templateId: entry.id } })).toBe(1);
    templateClock.now = realNow;
  });
});

describe("authorLabel contract (main decision 2026-10-06: optional display name, blank allowed)", () => {
  test("empty author display survives create → publish → public read → owner list", async () => {
    const owner = await makeUser();
    const token = bearer(owner);
    const blankAuthor = { ...blueprint, authorLabel: "" };
    const created = await app.inject({ method: "POST", url: "/templates", headers: { authorization: `Bearer ${token}` }, payload: { blueprint: blankAuthor } });
    expect(created.statusCode).toBe(201);
    expect(created.json().blueprint.authorLabel).toBe(""); // optional author, not coerced to a placeholder
    const published = await app.inject({ method: "POST", url: `/templates/${created.json().id}/publish`, headers: { authorization: `Bearer ${token}` }, payload: { revision: 1, reviewed: true, rightsConfirmed: true } });
    expect(published.statusCode).toBe(200);
    const pub = await app.inject({ method: "GET", url: `/template-shares/${published.json().token}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().blueprint).toEqual(blankAuthor); // strict blueprint round-trips a blank author
    const list = await app.inject({ method: "GET", url: "/templates", headers: { authorization: `Bearer ${token}` } });
    expect(list.json()[0].blueprint.authorLabel).toBe("");
    // Optional does not bypass validation when filled: non-empty unsafe author text is still rejected.
    expect((await app.inject({ method: "POST", url: "/templates", headers: { authorization: `Bearer ${token}` }, payload: { blueprint: { ...blueprint, authorLabel: "person\uFF20example.com" } } })).statusCode).toBe(400);
  });
});

describe("C10: PUT response is symmetric and never leaks the capability token", () => {
  test("PUT returns id/revision/blueprint/published with no token, reflecting the active share", async () => {
    const owner = await makeUser();
    const token = bearer(owner);
    const created = (await app.inject({ method: "POST", url: "/templates", headers: { authorization: `Bearer ${token}` }, payload: { blueprint } })).json();
    const draftPut = (await app.inject({ method: "PUT", url: `/templates/${created.id}`, headers: { authorization: `Bearer ${token}` }, payload: { blueprint: { ...blueprint, title: "Edit A" }, revision: 1 } })).json();
    expect(draftPut).toEqual({ id: created.id, revision: 2, blueprint: { ...blueprint, title: "Edit A" }, published: false });
    const published = (await app.inject({ method: "POST", url: `/templates/${created.id}/publish`, headers: { authorization: `Bearer ${token}` }, payload: { revision: 2, reviewed: true, rightsConfirmed: true } })).json();
    const publishedPut = await app.inject({ method: "PUT", url: `/templates/${created.id}`, headers: { authorization: `Bearer ${token}` }, payload: { blueprint: { ...blueprint, title: "Edit B" }, revision: 2 } });
    expect(publishedPut.statusCode).toBe(200);
    const body = publishedPut.json();
    expect(body.published).toBe(true); // the live share is still active
    expect(body.revision).toBe(3);
    expect("token" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain(published.token); // capability never echoed outside publish
    // Draft edits must not rewrite the pinned publication: the share shows the
    // "Edit A" blueprint that was live at publish time, never "Edit B".
    expect((await app.inject({ method: "GET", url: `/template-shares/${published.token}` })).json()).toEqual({ blueprint: { ...blueprint, title: "Edit A" } });
  });
});
