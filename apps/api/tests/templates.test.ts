import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TEMPLATE_SCENARIOS } from "@living-cost-manager/shared";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";
const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = await buildApp({ prisma, env: loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: "template-isolated-test-secret-at-least-32" }) });
const blueprint = TEMPLATE_SCENARIOS[0];
const ids: string[] = [];
let token: string, other: string, unverified: string;
async function user(verified: boolean) {
  const user = await prisma.user.create({ data: { email: `template-test-${crypto.randomUUID()}@example.com`, name: "Isolated", passwordHash: "not-a-login-hash", ...(verified ? { emailVerifiedAt: new Date() } : {}) } });
  ids.push(user.id); return app.signTokens(user).accessToken;
}
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, access?: string, payload?: unknown) => app.inject({ method, url, ...(access ? { headers: { authorization: `Bearer ${access}` } } : {}), ...(payload ? { payload } : {}) });
async function create() { const r = await call("POST", "/templates", token, { blueprint }); expect(r.statusCode).toBe(201); return r.json(); }
beforeAll(async () => { await prisma.$connect(); token = await user(true); other = await user(true); unverified = await user(false); });
afterAll(async () => { await prisma.user.deleteMany({ where: { id: { in: ids } } }); await app.close(); await prisma.$disconnect(); });
describe("durable private template and pinned public publication", () => {
  test("unauthenticated or unverified authors cannot save/publish", async () => {
    expect((await call("POST", "/templates", undefined, { blueprint })).statusCode).toBe(401);
    expect((await call("POST", "/templates", unverified, { blueprint })).statusCode).toBe(403);
    expect((await call("GET", "/templates")).statusCode).toBe(401);
  });
  test("strict privacy contract rejects financial and original ID payloads and caps bytes", async () => {
    for (const field of ["amount", "monthlyIncome", "cards", "billingDay", "billingAnchorDate", "originalId", "history", "renewalStatus", "confirmedMonthlySavings"]) {
      expect((await call("POST", "/templates", token, { blueprint: { ...blueprint, items: [{ ...blueprint.items[0], [field]: "PRIVATE" }] } })).statusCode).toBe(400);
    }
    expect((await call("POST", "/templates", token, { blueprint: { ...blueprint, description: "a".repeat(110000) } })).statusCode).toBe(413);
  });
  test("owner CRUD and revision conflicts cannot cross accounts", async () => {
    const entry = await create();
    expect((await call("GET", "/templates", other)).json()).toEqual([]);
    for (const method of ["PUT", "DELETE"] as const) expect((await call(method, `/templates/${entry.id}`, other, method === "PUT" ? { blueprint, revision: 1 } : undefined)).statusCode).toBe(404);
    expect((await call("POST", `/templates/${entry.id}/publish`, other, { revision: 1, reviewed: true, rightsConfirmed: true })).statusCode).toBe(404);
    const changes = { ...blueprint, title: "Edited original blueprint" };
    const results = await Promise.all([call("PUT", `/templates/${entry.id}`, token, { blueprint: changes, revision: 1 }), call("PUT", `/templates/${entry.id}`, token, { blueprint, revision: 1 })]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    await call("DELETE", `/templates/${entry.id}`, token);
  });
  test("published snapshot excludes owner IDs, drafts and raw private fields; revoke/republish/delete are effective", async () => {
    const entry = await create();
    expect((await call("POST", `/templates/${entry.id}/publish`, token, { revision: 1, reviewed: true })).statusCode).toBe(400);
    const publish = async (revision: number) => { const r = await call("POST", `/templates/${entry.id}/publish`, token, { revision, reviewed: true, rightsConfirmed: true }); expect(r.statusCode).toBe(200); return r.json().token as string; };
    const first = await publish(1);
    const publicRead = await call("GET", `/template-shares/${first}`);
    expect(publicRead.json()).toEqual({ blueprint });
    expect(publicRead.headers["cache-control"]).toBe("no-store");
    expect(publicRead.headers["x-robots-tag"]).toBe("noindex, nofollow");
    await call("PUT", `/templates/${entry.id}`, token, { blueprint: { ...blueprint, title: "Unpublished draft" }, revision: 1 });
    expect((await call("GET", `/template-shares/${first}`)).json()).toEqual({ blueprint });
    expect((await call("POST", `/templates/${entry.id}/publish`, token, { revision: 1, reviewed: true, rightsConfirmed: true })).statusCode).toBe(409);
    expect((await call("DELETE", `/templates/${entry.id}/share`, other)).statusCode).toBe(404);
    await call("DELETE", `/templates/${entry.id}/share`, token);
    expect((await call("GET", `/template-shares/${first}`)).statusCode).toBe(404);
    const second = await publish(2); expect(second).not.toBe(first);
    expect((await call("GET", `/template-shares/${first}`)).statusCode).toBe(404);
    await call("DELETE", `/templates/${entry.id}`, token);
    expect((await call("GET", `/template-shares/${second}`)).statusCode).toBe(404);
    expect(await prisma.budgetTemplateShare.count({ where: { templateId: entry.id } })).toBe(0);
  });
  test("expiry and account deletion cascade; no public listing endpoint", async () => {
    const entry = await create();
    const published = (await call("POST", `/templates/${entry.id}/publish`, token, { revision: 1, reviewed: true, rightsConfirmed: true })).json();
    await prisma.budgetTemplateShare.update({ where: { templateId: entry.id }, data: { expiresAt: new Date(0) } });
    expect((await call("GET", `/template-shares/${published.token}`)).statusCode).toBe(404);
    expect((await call("GET", "/template-shares")).statusCode).toBe(404);
    await call("DELETE", `/templates/${entry.id}`, token);
    const doomed = await prisma.user.create({ data: { email: `template-test-${crypto.randomUUID()}@example.com`, name: "Doomed", passwordHash: "synthetic" } }); ids.push(doomed.id);
    const owned = await prisma.budgetTemplate.create({ data: { userId: doomed.id, blueprint } });
    await prisma.budgetTemplateShare.create({ data: { templateId: owned.id, token: "z".repeat(43), blueprint, expiresAt: new Date(Date.now() + 10000) } });
    await prisma.user.delete({ where: { id: doomed.id } });
    expect(await prisma.budgetTemplate.count({ where: { id: owned.id } })).toBe(0);
    expect(await prisma.budgetTemplateShare.count({ where: { templateId: owned.id } })).toBe(0);
  });
  test("concurrent creates serialize against the account quota", async () => {
    const existing = await prisma.budgetTemplate.count({ where: { userId: ids[0] } });
    for (let i = existing; i < 19; i++) await create();
    const results = await Promise.all([call("POST", "/templates", token, { blueprint }), call("POST", "/templates", token, { blueprint })]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.budgetTemplate.count({ where: { userId: ids[0] } })).toBe(20);
  });
  test("public reads rate-limit malformed/unknown tokens without disabling the test gate globally", async () => {
    const limited = await buildApp({ prisma, env: loadEnv({ NODE_ENV: "development", DATABASE_URL: databaseUrl, JWT_SECRET: "template-isolated-test-secret-at-least-32" }) });
    try { let status = 0; for (let i = 0; i < 31; i++) status = (await limited.inject({ method: "GET", url: "/template-shares/not-a-token" })).statusCode; expect(status).toBe(429); }
    finally { await limited.close(); }
  });
});
