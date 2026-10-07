/** Opt-in LOCAL synthetic dump/restore rehearsal, not included in vitest runs.
 * Refuses every runtime target and operates only on our explicitly named
 * disposable loopback Docker PG16. Never prints URLs, keys or fixture rows. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../src/env.js";
import { ServiceBillingService } from "../src/services/service-billing.js";
import { decryptBillingKey, instrumentAAD } from "../src/services/service-billing-provider.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

const sourceUrl = resolveApiTestDatabaseUrl();
const url = new URL(sourceUrl);
const directory = process.env.BILLING_TEST_EVIDENCE_DIR;
if (process.env.BILLING_TEST_RESTORE !== "true" || !directory || !isAbsolute(directory) ||
  url.hostname !== "127.0.0.1" || !["55439", "55440"].includes(url.port) || url.pathname !== "/lcm_billing_test" ||
  url.searchParams.get("schema") !== "billing_test" || url.username !== "postgres" || url.password) {
  throw new Error("Refusing non-isolated billing restore target");
}
const container = url.port === "55440" ? "lcm-billing-provider-test" : "lcm-billing-backend-test";
const inspect = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0];
if (inspect.Config.Image !== "postgres:16-alpine" ||
  inspect.NetworkSettings.Ports["5432/tcp"]?.[0]?.HostIp !== "127.0.0.1" ||
  inspect.NetworkSettings.Ports["5432/tcp"]?.[0]?.HostPort !== url.port) throw new Error("Refusing unexpected test container");
const key = randomBytes(32);
const prisma = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
const restoreName = `lcm_billing_restore_test_${randomUUID().replaceAll("-", "")}`;
const restoreUrl = new URL(sourceUrl); restoreUrl.pathname = `/${restoreName}`;
const restored = new PrismaClient({ datasources: { db: { url: restoreUrl.toString() } } });
let created = false;
try {
  const settings = loadEnv({ NODE_ENV: "test", DATABASE_URL: sourceUrl, JWT_SECRET: randomBytes(40).toString("base64"),
    SERVICE_PAID_FEATURES_PUBLISHED: "true", SERVICE_BILLING_MODE: "mock", SERVICE_BILLING_MOCK_ENABLED: "true", SERVICE_BILLING_ENCRYPTION_KEY: key.toString("base64"), SERVICE_BILLING_KEY_VERSION: "restore-test-v1" });
  const service = new ServiceBillingService(prisma, settings);
  const user = await prisma.user.create({ data: { email: `billing-test-${randomUUID()}@example.invalid`, name: "Synthetic restore", passwordHash: "not-login-capable", emailVerifiedAt: new Date() } });
  const q = await service.createQuote(user.id, "monthly");
  const i = await service.prepare(user.id, q.quoteId);
  const token = `mock_${i.sdkRequest.issueId}`;
  await service.confirm(user.id, i.instrumentId, token);
  const a = await service.charge(user.id, { quoteId: q.quoteId, instrumentId: i.instrumentId, idempotencyKey: randomUUID(),
    consent: { billingVersion: q.consentVersions.billing, autoRenewVersion: q.consentVersions.autoRenew, accepted: true } });
  if (a.status !== "paid") throw new Error("Synthetic source payment did not settle");
  const counts = async (client: PrismaClient) => ({ users: await client.user.count(), contracts: await client.serviceSubscriptionContract.count(),
    quotes: await client.serviceBillingQuote.count(), instruments: await client.serviceBillingInstrument.count(),
    attempts: await client.servicePaymentAttempt.count(), periods: await client.servicePaidPeriod.count(),
    receipts: await client.serviceBillingEventReceipt.count(), refunds: await client.serviceRefundRecord.count() });
  const before = await counts(prisma);
  const dump = execFileSync("docker", ["exec", container, "pg_dump", "-U", "postgres", "--format=custom", "lcm_billing_test"], { maxBuffer: 64 * 1024 * 1024 });
  const backup = join(directory, `lcm-billing-synthetic-restore-${randomUUID()}.dump`);
  const fd = openSync(backup, "wx", 0o600); try { writeFileSync(fd, dump); } finally { closeSync(fd); }
  execFileSync("docker", ["exec", container, "createdb", "-U", "postgres", restoreName]); created = true;
  execFileSync("docker", ["exec", "-i", container, "pg_restore", "-U", "postgres", "--exit-on-error", "--dbname", restoreName], { input: dump });
  const after = await counts(restored);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Restore row counts differ");
  const envelope = await restored.serviceBillingInstrument.findUniqueOrThrow({ where: { id: i.instrumentId } });
  if (!envelope.ciphertext || !envelope.nonce || !envelope.authTag || !envelope.keyVersion ||
    decryptBillingKey({ ciphertext: envelope.ciphertext, nonce: envelope.nonce, authTag: envelope.authTag, keyVersion: envelope.keyVersion }, key, instrumentAAD(envelope)) !== token) {
    throw new Error("Restored synthetic instrument did not decrypt");
  }
  const migrations = await restored.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`;
  if (Number(migrations[0]?.count) !== 9) throw new Error("Restored migration metadata mismatch");
  console.log(JSON.stringify({ at: new Date().toISOString(), syntheticRestore: "passed", migrationCount: 9,
    counts: after, backup, envelopeDecryption: "passed", productionTouched: false }));
} finally {
  await restored.$disconnect(); await prisma.$disconnect();
  if (created) execFileSync("docker", ["exec", container, "dropdb", "-U", "postgres", restoreName]);
}
