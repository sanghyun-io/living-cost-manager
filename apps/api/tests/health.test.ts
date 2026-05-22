import { afterAll, expect, test } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET = "test-secret-with-at-least-32-characters";

const { buildApp } = await import("../src/app.js");

const app = await buildApp();

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
