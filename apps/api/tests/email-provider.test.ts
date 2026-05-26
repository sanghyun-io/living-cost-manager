import { describe, expect, test } from "vitest";

import { loadEnv } from "../src/env.js";
import { createEmailProvider, normalizeEmail } from "../src/services/email.js";

const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://x/y?schema=lcm_test",
  JWT_SECRET: "test-secret-with-at-least-32-characters"
};

describe("createEmailProvider", () => {
  test("falls back to console provider when no mail credentials are set", () => {
    const provider = createEmailProvider(loadEnv(baseEnv));
    expect(provider.kind).toBe("console");
  });

  test("selects resend when RESEND_API_KEY is present", () => {
    const provider = createEmailProvider(loadEnv({ ...baseEnv, RESEND_API_KEY: "re_test_key" }));
    expect(provider.kind).toBe("resend");
  });

  test("selects smtp when full SMTP config is present", () => {
    const provider = createEmailProvider(
      loadEnv({
        ...baseEnv,
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "587",
        SMTP_USER: "user",
        SMTP_PASS: "pass"
      })
    );
    expect(provider.kind).toBe("smtp");
  });

  test("explicit EMAIL_PROVIDER=console overrides available resend key", () => {
    const provider = createEmailProvider(
      loadEnv({ ...baseEnv, EMAIL_PROVIDER: "console", RESEND_API_KEY: "re_test_key" })
    );
    expect(provider.kind).toBe("console");
  });

  test("explicit EMAIL_PROVIDER=resend without key throws", () => {
    expect(() => createEmailProvider(loadEnv({ ...baseEnv, EMAIL_PROVIDER: "resend" }))).toThrow();
  });
});

describe("normalizeEmail", () => {
  test("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
  });
});
