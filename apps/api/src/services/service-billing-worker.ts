import { PrismaClient } from "@prisma/client";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { loadEnv, type Env } from "../env.js";
import { ServiceBillingService } from "./service-billing.js";

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
  if (!Number.isInteger(loops) || loops < 1 || loops > 10) throw new Error("Worker requires 1..10 bounded loops");
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const service = new ServiceBillingService(prisma, env);
    if (!service.readiness().capabilities.charge) throw new Error("Local mock configuration incomplete");
    let attemptsVisited = 0;
    for (let n = 0; n < loops; n++) {
      attemptsVisited += await service.reconcileOnce(25);
      if (n + 1 < loops) await setTimeout(1000);
    }
    return { loops, attemptsVisited, chargesDispatched: 0 };
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const bounded = args.length === 1 && /^--bounded=[1-9][0-9]?$/.test(args[0]!);
  if (args.length !== 1 || (!bounded && args[0] !== "--once")) throw new Error("Explicit --once or --bounded=1..10 required");
  const loops = args[0] === "--once" ? 1 : Number(args[0]!.split("=")[1]);
  // Parameter values are never printed; .env files aren't read by this worker.
  try { console.log(await runLocalMockBillingWorker(loadEnv(), loops)); }
  catch { console.error("LOCAL_MOCK_BILLING_WORKER_FAILED"); process.exitCode = 1; }
}
