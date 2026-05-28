import { expect, test, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  JWT_SECRET: "test-secret-with-at-least-32-characters"
});

test("loadEnv validates supplied configuration without reading process.env", () => {
  const loaded = loadEnv({
    DATABASE_URL: "postgresql://example:example@localhost:5432/example",
    JWT_SECRET: "another-test-secret-with-32-characters"
  });

  expect(loaded).toMatchObject({
    NODE_ENV: "development",
    PORT: 4000,
    CORS_ORIGIN: ["https://living-cost-manager.gamja.top", "https://sanghyun-io.github.io"]
  });
});

test("buildApp decorates injected Prisma and leaves injected lifecycle to caller", async () => {
  const prisma = {
    $disconnect: vi.fn(async () => undefined)
  } as unknown as PrismaClient;
  const app = await buildApp({ env, prisma });

  expect(app.prisma).toBe(prisma);

  await app.close();

  expect(prisma.$disconnect).not.toHaveBeenCalled();
});

test("CORS preflight allows the snapshot PUT from an allowed origin", async () => {
  const prisma = {
    $disconnect: vi.fn(async () => undefined)
  } as unknown as PrismaClient;
  const app = await buildApp({ env, prisma });

  const response = await app.inject({
    method: "OPTIONS",
    url: "/workspaces/ws-1/snapshot",
    headers: {
      origin: "https://living-cost-manager.gamja.top",
      "access-control-request-method": "PUT"
    }
  });

  expect(response.statusCode).toBe(204);
  const allowMethods = response.headers["access-control-allow-methods"];
  expect(allowMethods).toBeDefined();
  expect(String(allowMethods)).toContain("PUT");
  expect(response.headers["access-control-allow-origin"]).toBe(
    "https://living-cost-manager.gamja.top"
  );

  await app.close();
});
