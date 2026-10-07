import { expect, test } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { BillingController } from "../app/features/service-subscription/billing/controller";
import { createBillingApi } from "../app/features/service-subscription/billing/api";
import { browserBillingSdk } from "../app/features/service-subscription/billing/sdk";

// Opt-in ONLY to the dedicated synthetic loopback test DB. Never use DATABASE_URL.
test.skipIf(process.env.LCM_WEB_LOCAL_BILLING_TEST !== "true")("frozen real API + synthetic DB/mock provider + frontend adapter, lost-response lookup without redispatch", async () => {
  const { resolveApiTestDatabaseUrl } = await import("../../api/tests/test-database");
  const database = resolveApiTestDatabaseUrl();
  const { PrismaClient } = await import("@prisma/client");
  const { envSchema } = await import("../../api/src/env");
  const { buildApp } = await import("../../api/src/app");
  const { MockServiceBillingProvider } = await import("../../api/src/services/service-billing-provider");
  const prisma = new PrismaClient({ datasources: { db: { url: database } } });
  const env = envSchema.parse({ NODE_ENV: "test", DATABASE_URL: database, JWT_SECRET: randomBytes(32).toString("hex"),
    API_BASE_PATH: "/living-cost-manager/v1", SERVICE_BILLING_MODE: "mock", SERVICE_BILLING_MOCK_ENABLED: "true",
    SERVICE_PAID_FEATURES_PUBLISHED: "true", // Private in-process paid fixture only; public defaults stay dark.
    SERVICE_BILLING_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SERVICE_BILLING_KEY_VERSION: "synthetic_ui_test" });
  const provider = new MockServiceBillingProvider();
  const app = await buildApp({ env, prisma, logger: false, serviceBillingProvider: provider });
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL;
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:3198/living-cost-manager/v1";
  try {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@synthetic.invalid`, name: "Synthetic UI test", passwordHash: "unusable-synthetic-fixture", emailVerifiedAt: new Date() } });
    const token = app.signTokens(user).accessToken;
    let postCharges = 0, lookup = 0, loseResponse = true;
    const transport: typeof fetch = async (input, options) => {
      const url = new URL(String(input));
      if (url.origin !== "http://127.0.0.1:3198") throw new Error("Local-only transport");
      if (url.pathname.endsWith("/charges")) postCharges++;
      if (url.pathname.includes("/attempts/by-idempotency/")) lookup++;
      const result = await app.inject({ method: (options?.method ?? "GET") as "GET" | "POST", url: url.pathname,
        headers: options?.headers as Record<string, string>, ...(options?.body ? { payload: String(options.body) } : {}) });
      if (url.pathname.endsWith("/charges") && loseResponse) { loseResponse = false; throw new Error("Synthetic response loss after commit"); }
      return new Response(result.body, { status: result.statusCode, headers: { "content-type": "application/json" } });
    };
    const api = createBillingApi(token, transport)!;
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const c = new BillingController(api, browserBillingSdk("localhost"), user.id, storage);
    await c.load(true); expect(c.state.readiness?.approvalStatus).toBe("mock_draft");
    await c.quote("monthly"); expect(c.state.quote?.totalAmount).toBe(990); expect(c.state.quote?.approvedMaterial).toBeNull();
    c.consent("billing", true); c.consent("renewal", true); await c.pay();
    expect(postCharges).toBe(1); expect(provider.dispatchCount).toBe(1); expect(c.state.intent?.phase).toBe("charging");
    const recovered = new BillingController(api, browserBillingSdk("localhost"), user.id, storage);
    await recovered.load(true); expect(lookup).toBe(1); expect(recovered.state.attempt?.status).toBe("paid");
    expect(recovered.state.subscription?.paidAccess).toBe(false); await recovered.pay(); expect(postCharges).toBe(1);
    await recovered.refund(); expect(recovered.state.refund?.status).toBe("requested"); expect(recovered.state.refund?.requestAmount).toBe(990);
    await recovered.cancel(); expect(recovered.state.subscription?.renewalStopped).toBe(true);
    expect(JSON.stringify([...values])).not.toContain("mock_lcm_issue"); expect(JSON.stringify([...values])).not.toContain(token);
    c.dispose(); recovered.dispose();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL; else process.env.NEXT_PUBLIC_API_BASE_URL = previous;
    await app.close(); await prisma.$disconnect();
  }
}, 30000);
