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
