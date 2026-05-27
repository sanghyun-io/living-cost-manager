import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { hashToken } from "../src/services/tokens.js";
import {
  authTestEmailPrefix,
  cleanupAuthTestRecords,
  resolveApiTestDatabaseUrl
} from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const runId = `${authTestEmailPrefix}${Date.now()}`;
const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  JWT_SECRET: "test-secret-with-at-least-32-characters",
  EMAIL_PROVIDER: "console"
});

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = await buildApp({ env, prisma });

type RegisterResult = {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; emailVerified?: boolean };
};

async function register(email: string, password = "password123", name = "User") {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password, name }
  });
  return res.json<RegisterResult>();
}

beforeAll(async () => {
  await prisma.$connect();
  await cleanupAuthTestRecords(prisma);
});
afterEach(async () => {
  await cleanupAuthTestRecords(prisma);
});
afterAll(async () => {
  await cleanupAuthTestRecords(prisma);
  await app.close();
  await prisma.$disconnect();
});

describe("change-password", () => {
  test("changes password and invalidates old tokens (tokenVersion bump)", async () => {
    const email = `${runId}-cp@example.com`;
    const { accessToken } = await register(email);

    const before = await prisma.user.findUnique({ where: { email }, select: { tokenVersion: true } });

    const res = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: "password123", newPassword: "newpassword456" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ accessToken: string; refreshToken: string }>();
    expect(body.accessToken).toEqual(expect.any(String));

    const after = await prisma.user.findUnique({ where: { email }, select: { tokenVersion: true } });
    expect(after!.tokenVersion).toBe(before!.tokenVersion + 1);

    // Old access token now rejected by tokenVersion mismatch.
    const meOld = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(meOld.statusCode).toBe(401);

    // New token works.
    const meNew = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${body.accessToken}` }
    });
    expect(meNew.statusCode).toBe(200);

    // New password logs in, old does not.
    const okLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "newpassword456" }
    });
    expect(okLogin.statusCode).toBe(200);
    const badLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "password123" }
    });
    expect(badLogin.statusCode).toBe(401);
  });

  test("rejects wrong current password", async () => {
    const email = `${runId}-cp-wrong@example.com`;
    const { accessToken } = await register(email);
    const res = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: "wrongpassword", newPassword: "newpassword456" }
    });
    expect(res.statusCode).toBe(401);
  });

  test("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      payload: { currentPassword: "password123", newPassword: "newpassword456" }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("refresh + logout", () => {
  test("refresh issues new tokens", async () => {
    const email = `${runId}-refresh@example.com`;
    const { refreshToken } = await register(email);
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ accessToken: string; refreshToken: string }>();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
  });

  test("logout bumps tokenVersion and invalidates refresh", async () => {
    const email = `${runId}-logout@example.com`;
    const { accessToken, refreshToken } = await register(email);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(logout.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken }
    });
    expect(res.statusCode).toBe(401);
  });

  test("access token cannot be used as refresh token", async () => {
    const email = `${runId}-wrongtype@example.com`;
    const { accessToken } = await register(email);
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: accessToken }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("password reset", () => {
  test("forgot-password returns 200 for unknown email without creating a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/forgot-password",
      payload: { email: `${runId}-nouser@example.com` }
    });
    expect(res.statusCode).toBe(200);
    const count = await prisma.passwordResetToken.count();
    expect(count).toBe(0);
  });

  test("full reset flow with token from DB", async () => {
    const email = `${runId}-reset@example.com`;
    await register(email);

    const forgot = await app.inject({
      method: "POST",
      url: "/auth/forgot-password",
      payload: { email }
    });
    expect(forgot.statusCode).toBe(200);

    // ConsoleProvider does not expose the raw token; reset flow is validated by
    // crafting the same hash path: re-issue is not possible, so we read the row
    // and confirm a usable token exists, then drive reset with a known raw value.
    const user = await prisma.user.findUnique({ where: { email } });
    const row = await prisma.passwordResetToken.findFirst({
      where: { userId: user!.id, usedAt: null }
    });
    expect(row).toBeTruthy();

    // We cannot recover the raw token from the hash, so verify rejection paths
    // and the happy path via a directly-seeded token.
    const rawSeed = "seed-raw-token-value-for-test-1234567890";
    await prisma.passwordResetToken.create({
      data: {
        userId: user!.id,
        tokenHash: hashToken(rawSeed),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });

    const reset = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { token: rawSeed, password: "resetpassword789" }
    });
    expect(reset.statusCode).toBe(200);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "resetpassword789" }
    });
    expect(login.statusCode).toBe(200);
  });

  test("reset rejects invalid, expired, and reused tokens", async () => {
    const email = `${runId}-reset-bad@example.com`;
    await register(email);
    const user = await prisma.user.findUnique({ where: { email } });

    // invalid
    const invalid = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { token: "totally-wrong-token", password: "whatever123" }
    });
    expect(invalid.statusCode).toBe(400);

    // expired
    const expiredRaw = "expired-raw-token-1234567890";
    await prisma.passwordResetToken.create({
      data: {
        userId: user!.id,
        tokenHash: hashToken(expiredRaw),
        expiresAt: new Date(Date.now() - 1000)
      }
    });
    const expired = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { token: expiredRaw, password: "whatever123" }
    });
    expect(expired.statusCode).toBe(400);

    // reuse
    const reuseRaw = "reuse-raw-token-1234567890";
    await prisma.passwordResetToken.create({
      data: {
        userId: user!.id,
        tokenHash: hashToken(reuseRaw),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    const first = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { token: reuseRaw, password: "firstpass123" }
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      payload: { token: reuseRaw, password: "secondpass123" }
    });
    expect(second.statusCode).toBe(400);
  });
});

describe("email verification", () => {
  test("register creates an unverified user and a verification token", async () => {
    const email = `${runId}-verify@example.com`;
    const { user } = await register(email);
    expect(user.emailVerified).toBe(false);

    const count = await prisma.emailVerificationToken.count({ where: { userId: user.id } });
    expect(count).toBe(1);
  });

  test("verify-email marks user verified and is single-use", async () => {
    const email = `${runId}-verify2@example.com`;
    const { user } = await register(email);

    const rawSeed = "verify-raw-token-1234567890";
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawSeed),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });

    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify-email",
      payload: { token: rawSeed }
    });
    expect(verify.statusCode).toBe(200);

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed!.emailVerifiedAt).not.toBeNull();

    // reuse rejected
    const again = await app.inject({
      method: "POST",
      url: "/auth/verify-email",
      payload: { token: rawSeed }
    });
    expect(again.statusCode).toBe(400);
  });

  test("resend-verification works for unverified user", async () => {
    const email = `${runId}-resend@example.com`;
    const { accessToken, user } = await register(email);

    const res = await app.inject({
      method: "POST",
      url: "/auth/resend-verification",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(res.statusCode).toBe(200);

    // old token invalidated, a new active token exists
    const active = await prisma.emailVerificationToken.count({
      where: { userId: user.id, usedAt: null }
    });
    expect(active).toBe(1);
  });
});
