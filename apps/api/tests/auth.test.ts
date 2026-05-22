import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://living_cost:living_cost_dev@localhost:5432/living_cost_manager";
const runId = `auth-${Date.now()}`;
const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  JWT_SECRET: "test-secret-with-at-least-32-characters"
});

const prisma = new PrismaClient({
  datasourceUrl: databaseUrl
});
const app = await buildApp({ env, prisma });
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();

async function cleanupCreatedRecords() {
  const workspaceIds = [...createdWorkspaceIds];
  const userIds = [...createdUserIds];

  if (workspaceIds.length > 0) {
    await prisma.workspace.deleteMany({
      where: {
        id: {
          in: workspaceIds
        }
      }
    });
    createdWorkspaceIds.clear();
  }

  if (userIds.length > 0) {
    await prisma.user.deleteMany({
      where: {
        id: {
          in: userIds
        }
      }
    });
    createdUserIds.clear();
  }
}

async function registerTestUser(overrides: { email?: string; name?: string } = {}) {
  const email = overrides.email ?? `${runId}-${crypto.randomUUID()}@example.com`;
  const name = overrides.name ?? "Test User";
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email,
      password: "password123",
      name
    }
  });

  if (response.statusCode === 201) {
    const body = response.json<{
      user: { id: string; email: string; name: string };
      workspace: { id: string; name: string; role: string };
      token: string;
    }>();
    createdUserIds.add(body.user.id);
    createdWorkspaceIds.add(body.workspace.id);
  }

  return response;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  await cleanupCreatedRecords();
});

afterAll(async () => {
  await cleanupCreatedRecords();
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
      token: string;
      user: { id: string; email: string; name: string; passwordHash?: string };
      workspace: { id: string; name: string; role: string };
    }>();

    expect(body.token).toEqual(expect.any(String));
    expect(body.user).toEqual({
      id: expect.any(String),
      email: `${runId}-register@example.com`,
      name: "Mina"
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
      token: string;
      user: { id: string; email: string; name: string; passwordHash?: string };
    }>();
    expect(body.token).toEqual(expect.any(String));
    expect(body.user).toMatchObject({
      id: expect.any(String),
      email,
      name: "Login User"
    });
    expect(body.user).not.toHaveProperty("passwordHash");
  });

  test("/me succeeds with a bearer token", async () => {
    const email = `${runId}-me@example.com`;
    const register = await registerTestUser({ email, name: "Me User" });
    const token = register.json<{ token: string }>().token;

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
        name: "Me User"
      }
    });
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

  test("missing /me token returns unauthorized", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/me"
    });

    expect(response.statusCode).toBe(401);
  });
});
