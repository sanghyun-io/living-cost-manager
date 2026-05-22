import { afterAll, expect, test } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  JWT_SECRET: "test-secret-with-at-least-32-characters"
});
const prisma = {
  $disconnect: async () => undefined
} as unknown as PrismaClient;
const app = await buildApp({ env, prisma });

afterAll(async () => {
  await app.close();
});

test("GET /health returns ok", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/health"
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
});

test("serves health under configured API base path", async () => {
  const prefixedEnv = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    JWT_SECRET: "test-secret-with-at-least-32-characters",
    API_BASE_PATH: "/living-cost-manager/v1"
  });
  const prefixedApp = await buildApp({ env: prefixedEnv, prisma });

  try {
    const prefixed = await prefixedApp.inject({
      method: "GET",
      url: "/living-cost-manager/v1/health"
    });
    const root = await prefixedApp.inject({
      method: "GET",
      url: "/health"
    });

    expect(prefixed.statusCode).toBe(200);
    expect(prefixed.json()).toEqual({ ok: true });
    expect(root.statusCode).toBe(404);
  } finally {
    await prefixedApp.close();
  }
});
