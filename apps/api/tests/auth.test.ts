import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
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
  JWT_SECRET: "test-secret-with-at-least-32-characters"
});

const prisma = new PrismaClient({
  datasourceUrl: databaseUrl
});
const app = await buildApp({ env, prisma });

async function registerTestUser(overrides: { email?: string; name?: string } = {}) {
  const email = overrides.email ?? `${runId}-${crypto.randomUUID()}@example.com`;
  const name = overrides.name ?? "Test User";
  return app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email,
      password: "password123",
      name
    }
  });
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

describe("auth routes", () => {
  test("register creates a user and personal workspace owner membership", async () => {
    const response = await registerTestUser({
      email: `${runId}-register@example.com`,
      name: "Mina"
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      accessToken: string;
      refreshToken: string;
      user: { id: string; email: string; name: string; emailVerified?: boolean; passwordHash?: string };
      workspace: { id: string; name: string; role: string };
    }>();

    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.user).toEqual({
      id: expect.any(String),
      email: `${runId}-register@example.com`,
      name: "Mina",
      emailVerified: false
    });
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(body.workspace).toEqual({
      id: expect.any(String),
      name: "Mina의 생활비",
      role: "owner"
    });

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: body.workspace.id,
          userId: body.user.id
        }
      }
    });

    expect(membership).toMatchObject({
      workspaceId: body.workspace.id,
      userId: body.user.id,
      role: "owner"
    });
  });

  test("register stores and returns normalized email", async () => {
    const email = `${runId}-Normalize@example.com`;
    const response = await registerTestUser({
      email: `  ${email.toUpperCase()}  `,
      name: "Normalize User"
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      user: { id: string; email: string; name: string };
    }>();

    expect(body.user.email).toBe(email.toLowerCase());

    const user = await prisma.user.findUnique({
      where: {
        id: body.user.id
      },
      select: {
        email: true
      }
    });

    expect(user?.email).toBe(email.toLowerCase());
  });

  test("register access token includes type, version, expiry, issuer, audience", async () => {
    const response = await registerTestUser({
      email: `${runId}-jwt-claims@example.com`,
      name: "Jwt User"
    });
    const { accessToken, refreshToken } = response.json<{
      accessToken: string;
      refreshToken: string;
    }>();

    const decoded = app.jwt.verify<{
      sub: string;
      type: string;
      tokenVersion: number;
      exp: number;
      iat: number;
      iss: string;
      aud: string;
    }>(accessToken);

    expect(decoded).toMatchObject({
      sub: expect.any(String),
      type: "access",
      tokenVersion: 0,
      iss: "living-cost-manager-api",
      aud: "living-cost-manager"
    });
    // Access token is short-lived (<= 1h); refresh carries the long-lived window.
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(60 * 60);

    const decodedRefresh = app.jwt.verify<{ type: string }>(refreshToken);
    expect(decodedRefresh.type).toBe("refresh");
  });

  test("login succeeds and returns a token", async () => {
    const email = `${runId}-login@example.com`;
    await registerTestUser({ email, name: "Login User" });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email,
        password: "password123"
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      accessToken: string;
      refreshToken: string;
      user: { id: string; email: string; name: string; passwordHash?: string };
    }>();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.user).toMatchObject({
      id: expect.any(String),
      email,
      name: "Login User"
    });
    expect(body.user).not.toHaveProperty("passwordHash");
  });

  test("login accepts case-insensitive email input", async () => {
    const email = `${runId}-CaseLogin@example.com`;
    await registerTestUser({ email, name: "Case Login User" });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: `  ${email.toUpperCase()}  `,
        password: "password123"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: {
        email: email.toLowerCase(),
        name: "Case Login User"
      }
    });
  });

  test("/me succeeds with a bearer token", async () => {
    const email = `${runId}-me@example.com`;
    const register = await registerTestUser({ email, name: "Me User" });
    const token = register.json<{ accessToken: string }>().accessToken;

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        id: expect.any(String),
        email,
        name: "Me User",
        emailVerified: false
      }
    });
  });

  test("/me rejects a verified token with an invalid payload shape", async () => {
    const token = app.jwt.sign({});

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      message: "Invalid token"
    });
    expect(JSON.stringify(response.json())).not.toContain("claim");
  });

  test("/me rejects malformed tokens with a sanitized unauthorized response", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: "Bearer not-a-jwt"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      message: "Invalid token"
    });
    expect(JSON.stringify(response.json())).not.toContain("jwt");
  });

  test("/me rejects expired tokens with a sanitized unauthorized response", async () => {
    const token = app.jwt.sign(
      {
        sub: "expired-user-id"
      },
      {
        expiresIn: "-1s"
      }
    );

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      message: "Invalid token"
    });
    expect(JSON.stringify(response.json()).toLowerCase()).not.toContain("expired");
  });

  test("/me rejects bad-claim tokens with a sanitized unauthorized response", async () => {
    const token = app.jwt.sign({ sub: "missing-user-id" });

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      message: "Invalid token"
    });
    expect(JSON.stringify(response.json())).not.toContain("subject");
  });

  test("duplicate register returns a non-500 conflict", async () => {
    const email = `${runId}-duplicate@example.com`;
    await registerTestUser({ email, name: "First User" });

    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email,
        password: "password123",
        name: "Second User"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      message: "Email already registered"
    });
  });

  test("register rejects duplicate email with different casing", async () => {
    const email = `${runId}-case-duplicate@example.com`;
    await registerTestUser({ email: email.toUpperCase(), name: "First User" });

    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: email.toLowerCase(),
        password: "password123",
        name: "Second User"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      message: "Email already registered"
    });
  });

  test("bad login returns unauthorized", async () => {
    const email = `${runId}-bad-login@example.com`;
    await registerTestUser({ email, name: "Bad Login User" });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email,
        password: "wrong-password"
      }
    });

    expect(response.statusCode).toBe(401);
  });

  test("invalid register payload returns a sanitized bad request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "not-an-email",
        password: "short",
        name: ""
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: "Invalid request body"
    });
    expect(JSON.stringify(response.json())).not.toContain("ZodError");
  });

  test("invalid login payload returns a sanitized bad request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "not-an-email",
        password: "short"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: "Invalid request body"
    });
    expect(JSON.stringify(response.json())).not.toContain("ZodError");
  });

  test("missing /me token returns unauthorized", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/me"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      message: "Invalid token"
    });
  });
});
