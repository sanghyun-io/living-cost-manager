import { PrismaClient } from "@prisma/client";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { loadEnv, type Env } from "../env.js";
import { ServiceBillingService } from "./service-billing.js";
import { parseBillingConfiguration } from "./service-billing-config.js";
import type { ServiceBillingProvider } from "./service-billing-provider.js";

export function assertLocalMockBillingWorker(env: Env) {
  let url: URL;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error("Invalid isolated worker database configuration"); }
  const testName = /(^|[_-])test($|[_-])/;
  if (env.NODE_ENV === "production" || env.SERVICE_BILLING_MODE !== "mock" || env.SERVICE_BILLING_MOCK_ENABLED !== "true" ||
    !["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !testName.test(url.pathname.slice(1)) || !testName.test(url.searchParams.get("schema") ?? "")) {
    throw new Error("Billing worker requires isolated local mock test database");
  }
}

/** Opt-in bounded reconciliation ONLY. No renewal, charge retry or timers are
 * registered in server.ts/app.ts. Restarted synthetic provider has no remote
 * observations; unresolved persisted attempts go to manual review, not charge. */
export async function runLocalMockBillingWorker(env: Env, loops = 1) {
  assertLocalMockBillingWorker(env);
  return runBillingWorker(env, "reconcile", loops);
}
export async function runBillingWorker(env: Env, job: "reconcile" | "renew" | "refund", loops = 1,
  approval?: { requestId: string; operationId: string; policyVersion: string }, provider?: ServiceBillingProvider) {
  if (env.SERVICE_BILLING_MODE === "mock") assertLocalMockBillingWorker(env);
  else {
    const config = parseBillingConfiguration(env);
    if (!config.enabled || !config.manifest?.workers[job === "refund" ? "refunds" : job] ||
      (job !== "reconcile" && !config.capabilities[job === "refund" ? "refund" : "renew"])) throw new Error("Billing worker approval/capability required");
  }
  if (!Number.isInteger(loops) || loops < 1 || loops > 10) throw new Error("Worker requires 1..10 bounded loops");
  if (job === "refund" && (!approval || loops !== 1)) throw new Error("One explicitly approved refund operation required");
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const service = new ServiceBillingService(prisma, env, undefined, provider);
    let attemptsVisited = 0;
    for (let n = 0; n < loops; n++) {
      if (job === "reconcile") attemptsVisited += await service.reconcileOnce(10);
      if (job === "renew") attemptsVisited += await service.renewOnce(10);
      if (job === "refund") { await service.approveAndExecuteRefund(approval!.requestId, approval!.operationId, approval!.policyVersion); attemptsVisited++; }
      if (n + 1 < loops) await setTimeout(1000);
    }
    return { job, loops, attemptsVisited, ...(job === "reconcile" ? { chargesDispatched: 0 } : {}) };
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const seen = new Set<string>(); const flags: Record<string, string> = {};
    for (const arg of args) {
      const match = /^--(job|bounded|request|operation|policy)=(.+)$/.exec(arg);
      const key = arg === "--once" ? "once" : match?.[1];
      if (!key || seen.has(key)) throw new Error("Invalid worker arguments");
      seen.add(key); flags[key] = key === "once" ? "1" : match![2]!;
    }
    if ((!!flags.once === !!flags.bounded) || !["reconcile", "renew", "refund"].includes(flags.job ?? "")) throw new Error("Explicit job and bound required");
    const loops = Number(flags.once ?? flags.bounded);
    const job = flags.job as "reconcile" | "renew" | "refund";
    const approval = job === "refund" ? { requestId: flags.request ?? "", operationId: flags.operation ?? "", policyVersion: flags.policy ?? "" } : undefined;
    if (approval && (!/^[A-Za-z0-9_-]{1,128}$/.test(approval.requestId) || !/^[A-Za-z0-9_-]{16,128}$/.test(approval.operationId) || !/^[A-Za-z0-9_.-]{1,128}$/.test(approval.policyVersion))) throw new Error("Refund approval required");
    console.log(await runBillingWorker(loadEnv(), job, loops, approval));
  } catch { console.error("BILLING_WORKER_FAILED"); process.exitCode = 1; }
}
