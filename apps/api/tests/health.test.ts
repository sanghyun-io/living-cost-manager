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

test("응답에 helmet 보안 헤더가 포함된다", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/health"
  });

  // helmet 이 적용한 핵심 보안 헤더들.
  expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  // 비-운영(test)에서는 HSTS 를 끈다.
  expect(response.headers["strict-transport-security"]).toBeUndefined();
});

test("운영 환경에서는 HSTS 헤더를 켠다", async () => {
  const prodEnv = loadEnv({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    JWT_SECRET: "test-secret-with-at-least-32-characters"
  });
  const prodApp = await buildApp({ env: prodEnv, prisma });

  try {
    const response = await prodApp.inject({ method: "GET", url: "/health" });
    expect(response.headers["strict-transport-security"]).toContain("max-age=");
  } finally {
    await prodApp.close();
  }
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
