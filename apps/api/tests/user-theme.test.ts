import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { cleanupAuthTestRecords, resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const prefix = "auth-test-user-theme-";
const app = await buildApp({ prisma, env: loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: "synthetic-theme-secret-at-least-32-characters", EMAIL_PROVIDER: "console" }) });
const themeUrl = "/me/theme";
const meUrl = "/me";

async function user(verified = false) {
  const record = await prisma.user.create({ data: {
    email: `${prefix}${crypto.randomUUID()}@example.invalid`, name: "Synthetic theme fixture", passwordHash: "unused",
    emailVerifiedAt: verified ? new Date() : null
  } });
  const tokens = app.signTokens(record);
  return { ...record, ...tokens, headers: { authorization: `Bearer ${tokens.accessToken}` } };
}

beforeAll(() => prisma.$connect());
afterEach(() => cleanupAuthTestRecords(prisma, prefix));
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

test("authentication required on /me and /me/theme; stale (logged-out) tokens rejected", async () => {
  expect((await app.inject({ method: "GET", url: meUrl })).statusCode).toBe(401);
  expect((await app.inject({ method: "PUT", url: themeUrl, payload: { uiTheme: "jade" } })).statusCode).toBe(401);
  const f = await user();
  const fresh = await app.inject({ method: "GET", url: meUrl, headers: f.headers });
  expect(fresh.statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/auth/logout", headers: f.headers })).statusCode).toBe(200);
  expect((await app.inject({ method: "PUT", url: themeUrl, headers: f.headers, payload: { uiTheme: "aqua" } })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: meUrl, headers: f.headers })).statusCode).toBe(401);
});

test("new rows default to jade and every auth response carries the theme", async () => {
  const email = `${prefix}${crypto.randomUUID()}@example.invalid`;
  const registered = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "synthetic-password-1", name: "Synthetic register" } });
  expect(registered.statusCode).toBe(201);
  expect(registered.json().user.uiTheme).toBe("jade");
  const loggedIn = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "synthetic-password-1", name: "ignored" } });
  expect(loggedIn.json().user.uiTheme).toBe("jade");
  const row = await prisma.user.findUnique({ where: { email } });
  expect(row?.uiTheme).toBe("jade");
  const refreshed = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: loggedIn.json().refreshToken } });
  expect(refreshed.json().user.uiTheme).toBe("jade");
  expect((await app.inject({ method: "GET", url: meUrl, headers: { authorization: `Bearer ${loggedIn.json().accessToken}` } })).json().user.uiTheme).toBe("jade");
});

test("PUT accepts each approved id, updates own row only, and answers explicitly", async () => {
  const f = await user();
  for (const id of ["jade", "aqua", "violet", "raspberry", "tangerine"] as const) {
    const response = await app.inject({ method: "PUT", url: themeUrl, headers: f.headers, payload: { uiTheme: id } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ uiTheme: id });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ method: "GET", url: meUrl, headers: f.headers })).json().user.uiTheme).toBe(id);
  }
  const stored = await prisma.user.findUnique({ where: { id: f.id } });
  expect(stored?.uiTheme).toBe("tangerine");
  expect(stored?.name).toBe("Synthetic theme fixture"); // the body cannot carry anything else
  expect(stored?.tokenVersion).toBe(f.tokenVersion);    // theme writes never rotate tokens
});

test.each([
  ["invalid enum value", { uiTheme: "blue" }],
  ["case/whitespace drift", { uiTheme: "JADE" }],
  ["missing key", {}],
  ["null value", { uiTheme: null }],
  ["non-string value", { uiTheme: 42 }],
  ["wrong key name", { theme: "jade" }],
  ["unknown userId key (cross-target attempt)", { uiTheme: "aqua", userId: "victim-id" }],
  ["unknown extra key", { uiTheme: "aqua", workspaceId: "ws" }]
])("PUT rejects %s with 400 and does not write", async (_label, payload) => {
  const f = await user();
  await app.inject({ method: "PUT", url: themeUrl, headers: f.headers, payload: { uiTheme: "violet" } });
  expect((await app.inject({ method: "PUT", url: themeUrl, headers: f.headers, payload })).statusCode).toBe(400);
  expect((await prisma.user.findUnique({ where: { id: f.id } }))?.uiTheme).toBe("violet");
});

test("one user's theme never reads or writes another user's row", async () => {
  const a = await user();
  const b = await user();
  await app.inject({ method: "PUT", url: themeUrl, headers: a.headers, payload: { uiTheme: "raspberry" } });
  await app.inject({ method: "PUT", url: themeUrl, headers: b.headers, payload: { uiTheme: "aqua" } });
  expect((await app.inject({ method: "GET", url: meUrl, headers: a.headers })).json().user).toMatchObject({ id: a.id, uiTheme: "raspberry" });
  expect((await app.inject({ method: "GET", url: meUrl, headers: b.headers })).json().user).toMatchObject({ id: b.id, uiTheme: "aqua" });
  // even with a body naming the other user, only the token subject changes (400: strict body)
  expect((await app.inject({ method: "PUT", url: themeUrl, headers: a.headers, payload: { uiTheme: "tangerine", userId: b.id } })).statusCode).toBe(400);
  expect((await prisma.user.findUnique({ where: { id: b.id } }))?.uiTheme).toBe("aqua");
});

test("unverified email may set own theme (personal UI preference parity with product tour); verified not required", async () => {
  const f = await user(false);
  expect((await app.inject({ method: "PUT", url: themeUrl, headers: f.headers, payload: { uiTheme: "aqua" } })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: meUrl, headers: f.headers })).json().user).toMatchObject({ emailVerified: false, uiTheme: "aqua" });
});

test("legacy/corrupt stored values read as jade and GET never mutates them; a valid PUT heals the row", async () => {
  const f = await user();
  // Isolated synthetic cluster only: temporarily drop the DB CHECK to represent a
  // pre-constraint legacy/corrupt row, then restore it in the same test.
  await prisma.$executeRawUnsafe('ALTER TABLE "User" DROP CONSTRAINT "User_uiTheme_check"');
  try {
    await prisma.$executeRawUnsafe('UPDATE "User" SET "uiTheme" = \'legacy-magenta\' WHERE "id" = $1', f.id);
    const response = await app.inject({ method: "GET", url: meUrl, headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.uiTheme).toBe("jade"); // read fallback
    expect((await prisma.user.findUnique({ where: { id: f.id } }))?.uiTheme).toBe("legacy-magenta"); // GET did not mutate
    expect((await app.inject({ method: "PUT", url: themeUrl, headers: f.headers, payload: { uiTheme: "jade" } })).statusCode).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: f.id } }))?.uiTheme).toBe("jade");
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "User" ADD CONSTRAINT "User_uiTheme_check" CHECK ("uiTheme" IN (\'jade\', \'aqua\', \'violet\', \'raspberry\', \'tangerine\'))');
  }
});

test("theme survives full snapshot replace (delete/recreate of financial rows) and other prefs are untouched", async () => {
  const owner = await user(true);
  const workspace = await prisma.workspace.create({ data: {
    name: "Synthetic", monthlyIncome: 1000000,
    members: { create: { userId: owner.id, role: "owner" } },
    categories: { create: { id: "subscription", label: "구독" } }
  } });
  await prisma.fixedCost.create({ data: { id: "a", workspaceId: workspace.id, name: "Synthetic", categoryId: "subscription", paymentMethodId: "bank-transfer", amount: 10000, billingDay: 15 } });
  const before = {
    tour: await prisma.userProductTourState.count(),
    coaching: await prisma.userWorkspaceCoachingPreference.count()
  };
  await app.inject({ method: "PUT", url: themeUrl, headers: owner.headers, payload: { uiTheme: "violet" } });
  const snapshotUrl = `/workspaces/${workspace.id}/snapshot`;
  const snapshot = (await app.inject({ method: "GET", url: snapshotUrl, headers: owner.headers })).json();
  expect((await app.inject({ method: "PUT", url: snapshotUrl, headers: owner.headers, payload: snapshot })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: meUrl, headers: owner.headers })).json().user.uiTheme).toBe("violet");
  expect({
    tour: await prisma.userProductTourState.count(),
    coaching: await prisma.userWorkspaceCoachingPreference.count()
  }).toEqual(before);
});
