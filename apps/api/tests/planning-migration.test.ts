import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "vitest";
import { createDefaultWorkspacePlanningData } from "@living-cost-manager/shared";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migration = readFileSync(path.join(root, "prisma/migrations/20261018110000_workspace_planning_state/migration.sql"), "utf8");

test("exact additive SQL: bounded FK lock abort leaves no partial table or changed existing rows; apply and restore rehearsal", async () => {
  const schema = "planning_migration_test";
  const url = new URL(databaseUrl); url.searchParams.set("schema", schema);
  const source = new PrismaClient({ datasourceUrl: databaseUrl });
  const current = new PrismaClient({ datasourceUrl: url.toString() });
  const locking = new PrismaClient({ datasourceUrl: url.toString() });
  const psqlUrl = new URL(url); psqlUrl.searchParams.delete("schema"); psqlUrl.searchParams.set("options", `-csearch_path=${schema} -clc_messages=C`);
  const pgBin = process.env.LCM_CI_PG_BIN_DIR ?? "/opt/homebrew/opt/postgresql@16/bin";
  // libpq URI options require %20, not application/x-www-form-urlencoded '+'.
  const connection = psqlUrl.toString().replaceAll("+", "%20");
  const run = (sql: string) => execFileSync(path.join(pgBin, "psql"), ["-X", "--set", "ON_ERROR_STOP=1", "--dbname", connection], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  let release!: () => void; let ready!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { ready = resolve; });
  let held: Promise<unknown> | undefined;
  try {
    await source.$executeRawUnsafe('CREATE SCHEMA "planning_migration_test"');
    await source.$executeRawUnsafe('CREATE TABLE "planning_migration_test"."Workspace" (LIKE "Workspace" INCLUDING ALL)');
    const fixture = await current.workspace.create({ data: { name: "Synthetic pre-migration", monthlyIncome: 123456, syncVersion: 7 } });
    const before = await current.workspace.findMany();
    held = locking.$transaction(async tx => { await tx.$executeRawUnsafe('LOCK TABLE "Workspace" IN ACCESS EXCLUSIVE MODE'); ready(); await gate; }, { timeout: 20000 });
    await acquired;
    const start = Date.now();
    expect(() => run(migration)).toThrow(/lock timeout/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4900);
    release(); await held; held = undefined;
    expect((await current.$queryRaw<Array<{ name: string | null }>>`SELECT to_regclass('"WorkspacePlanningState"')::text AS name`)[0]?.name).toBeNull();
    expect(await current.workspace.findMany()).toEqual(before);
    run(migration);
    expect(await current.workspace.findMany()).toEqual(before);
    await current.workspacePlanningState.create({ data: { workspaceId: fixture.id, payloadJson: createDefaultWorkspacePlanningData() } });
    // Dump/restore ONLY this synthetic isolated schema into a separate disposable schema.
    const dump = execFileSync(path.join(pgBin, "pg_dump"), ["--dbname", connection, "--schema", schema, "--no-owner", "--no-privileges"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    run(dump.replaceAll(schema, "planning_restore_test"));
    const restored = await current.$queryRaw<Array<{ monthlyIncome: number; payloadJson: unknown }>>`SELECT w."monthlyIncome", p."payloadJson" FROM "planning_restore_test"."Workspace" w JOIN "planning_restore_test"."WorkspacePlanningState" p ON p."workspaceId" = w.id`;
    expect(restored).toEqual([{ monthlyIncome: 123456, payloadJson: createDefaultWorkspacePlanningData() }]);
  } finally {
    release(); if (held) await held;
    // Only synthetic schemas created by this test, never application migration rollback.
    await source.$executeRawUnsafe('DROP SCHEMA IF EXISTS "planning_restore_test" CASCADE');
    await source.$executeRawUnsafe('DROP SCHEMA IF EXISTS "planning_migration_test" CASCADE');
    await Promise.all([source.$disconnect(), current.$disconnect(), locking.$disconnect()]);
  }
}, 40000);

test("actual 260c8d4 client stays writable and cannot clear planning during cost delete/recreate", async () => {
  const temp = mkdtempSync(path.join(root, "node_modules/.planning-legacy-test-"));
  const output = path.join(temp, "client");
  const schema = execFileSync("git", ["show", "260c8d4:prisma/schema.prisma"], { cwd: root, encoding: "utf8" });
  writeFileSync(path.join(temp, "schema.prisma"), schema.replace('provider = "prisma-client-js"', `provider = "prisma-client-js"\n  output = ${JSON.stringify(output)}`));
  let old: PrismaClient | undefined;
  const current = new PrismaClient({ datasourceUrl: databaseUrl });
  let workspaceId: string | undefined;
  try {
    execFileSync("pnpm", ["prisma", "generate", "--schema", path.join(temp, "schema.prisma")], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" });
    const LegacyPrisma = createRequire(import.meta.url)(path.join(output, "index.js")).PrismaClient as typeof PrismaClient;
    old = new LegacyPrisma({ datasourceUrl: databaseUrl });
    expect("workspacePlanningState" in old).toBe(false);
    const workspace = await old.workspace.create({ data: { name: "Synthetic legacy", monthlyIncome: 500, categories: { create: { id: "other", label: "Other" } } } });
    workspaceId = workspace.id;
    const cost = { workspaceId, id: "cost", categoryId: "other", name: "Synthetic cost", paymentMethodId: "bank-transfer", amount: 100, billingDay: 10 };
    await old.fixedCost.create({ data: cost });
    const planning = await current.workspacePlanningState.create({ data: { workspaceId, payloadJson: { ...createDefaultWorkspacePlanningData(), reserves: [{ id: "reserve", costId: "cost", savedAmount: 50, targetAmount: null, targetDueDate: null, recordedAt: "2026-10-18T00:00:00Z" }] } } });
    await old.$transaction(async tx => {
      await tx.workspace.update({ where: { id: workspaceId }, data: { monthlyIncome: 1000, syncVersion: { increment: 1 } } });
      await tx.fixedCost.deleteMany({ where: { workspaceId } });
      await tx.fixedCost.create({ data: cost });
    });
    expect((await old.workspace.findUnique({ where: { id: workspaceId }, include: { fixedCosts: true } }))?.fixedCosts).toHaveLength(1);
    expect(await current.workspacePlanningState.findUnique({ where: { workspaceId } })).toEqual(planning);
    expect((await old.workspace.findUnique({ where: { id: workspaceId } }))?.monthlyIncome).toBe(1000);
  } finally {
    if (workspaceId) await current.workspace.deleteMany({ where: { id: workspaceId } });
    await Promise.all([old?.$disconnect(), current.$disconnect()]);
    rmSync(temp, { recursive: true, force: true });
  }
}, 40000);
