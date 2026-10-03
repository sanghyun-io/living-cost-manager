import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

afterEach(() => vi.unstubAllEnvs());

describe("destructive API test database guard", () => {
  it("never falls back to application DATABASE_URL", () => {
    vi.stubEnv("API_TEST_DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", "postgresql://user@localhost/app_test?schema=app_test");
    expect(() => resolveApiTestDatabaseUrl()).toThrow("Set API_TEST_DATABASE_URL");
  });
  it.each([
    "postgresql://user@remote.example/app_test?schema=app_test",
    "postgresql://user@localhost/production?schema=app_test",
    "postgresql://user@localhost/app_test?schema=production",
    "postgresql://user@localhost/app_test",
  ])("rejects unsafe reset target %s", (url) => {
    vi.stubEnv("API_TEST_DATABASE_URL", url);
    expect(() => resolveApiTestDatabaseUrl()).toThrow("not test-isolated");
  });
  it("accepts explicitly isolated loopback database and schema", () => {
    const url = "postgresql://user@127.0.0.1:55483/lcm_test?schema=lcm_test";
    vi.stubEnv("API_TEST_DATABASE_URL", url);
    expect(resolveApiTestDatabaseUrl()).toBe(url);
  });
});
