import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "vitest";

import { resolveApiTestDatabaseUrl } from "./test-database.js";
import { putProductTourState } from "../src/services/product-tour.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

// All writes go to the explicitly gated local test DB (never load .env).
const databaseUrl = resolveApiTestDatabaseUrl();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migration = readFileSync(path.join(root, "prisma/migrations/20261010000000_user_product_tour_state/migration.sql"), "utf8");

test("exact additive DDL lock-timeout rolls back completely then succeeds on retry", async () => {
  const source = new PrismaClient({ datasourceUrl: databaseUrl });
  const url = new URL(databaseUrl); url.searchParams.set("schema", "product_tour_lock_test");
  const lockDb = new PrismaClient({ datasourceUrl: url.toString() });
  const applyDb = new PrismaClient({ datasourceUrl: url.toString() });
  let release!: () => void;
  const releaseGate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const readyGate = new Promise<void>(resolve => { ready = resolve; });
  let held: Promise<unknown> | undefined;
  try {
    await source.$executeRawUnsafe('CREATE SCHEMA "product_tour_lock_test"');
    await source.$executeRawUnsafe('CREATE TABLE "product_tour_lock_test"."User" (LIKE "User" INCLUDING ALL)');
    const fixture = await applyDb.user.create({ data: { name: "Synthetic pre-migration", email: "pre-migration@example.invalid", passwordHash: "unused" } });
    const api = await buildApp({ prisma: applyDb, env: loadEnv({ NODE_ENV: "test", DATABASE_URL: url.toString(),
      JWT_SECRET: "synthetic-tour-secret-at-least-32-characters", EMAIL_PROVIDER: "console" }) });
    try {
      const headers = { authorization: `Bearer ${api.signTokens(fixture).accessToken}` };
      for (const method of ["GET", "PUT"] as const) {
        const response = await api.inject({ method, url: "/onboarding/product-tour", headers,
          payload: method === "PUT" ? { version: 1, status: "completed" } : undefined });
        expect(response.statusCode).toBe(500);
        expect(response.json().message).toBe("Product tour state unavailable");
        expect(response.body).not.toContain("unseen");
        expect(response.body).not.toContain("UserProductTourState");
      }
    } finally { await api.close(); }
    held = lockDb.$transaction(async tx => {
      await tx.$executeRawUnsafe('LOCK TABLE "User" IN ACCESS EXCLUSIVE MODE');
      ready(); await releaseGate;
    }, { timeout: 15000 });
    await readyGate;
    const start = Date.now();
    await expect(applyDb.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'");
      await tx.$executeRawUnsafe(migration); // Static checked-in SQL, no input interpolation.
    }, { timeout: 25000 })).rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
    expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
    const missing = await applyDb.$queryRaw<{ name: string | null }[]>`SELECT to_regclass('"UserProductTourState"')::text AS name`;
    expect(missing[0]?.name).toBeNull();
    release(); await held; held = undefined;
    await applyDb.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'");
      await tx.$executeRawUnsafe(migration);
    }, { timeout: 25000 });
    const present = await applyDb.$queryRaw<{ name: string | null }[]>`SELECT to_regclass('"UserProductTourState"')::text AS name`;
    expect(present[0]?.name).toBe('"UserProductTourState"');
    const constraints = await applyDb.$queryRaw<{ contype: string }[]>`
      SELECT contype::text FROM pg_constraint WHERE conrelid = '"UserProductTourState"'::regclass`;
    expect(constraints.map(row => row.contype).sort()).toEqual(["c", "c", "f", "p"]);
  } finally {
    release(); if (held) await held;
    await source.$executeRawUnsafe('DROP SCHEMA IF EXISTS "product_tour_lock_test" CASCADE');
    await Promise.all([source.$disconnect(), lockDb.$disconnect(), applyDb.$disconnect()]);
  }
}, 40000);

test("260c8d4 old generated client works unchanged beside new table and deletion cascades", async () => {
  // Generate the actual pre-tour schema, not a guessed old User shape. Output is
  // disposable ignored node_modules so no historical migration/schema is edited.
  const temp = mkdtempSync(path.join(root, "node_modules/.tour-legacy-test-"));
  const output = path.join(temp, "client");
  const schema = execFileSync("git", ["show", "260c8d4:prisma/schema.prisma"], { cwd: root, encoding: "utf8" });
  writeFileSync(path.join(temp, "schema.prisma"), schema.replace('provider = "prisma-client-js"',
    `provider = "prisma-client-js"\n  output = ${JSON.stringify(output)}`));
  execFileSync("pnpm", ["prisma", "generate", "--schema", path.join(temp, "schema.prisma")], {
    cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe"
  });
  const require = createRequire(import.meta.url);
  const LegacyPrisma = require(path.join(output, "index.js")).PrismaClient as typeof PrismaClient;
  const old = new LegacyPrisma({ datasourceUrl: databaseUrl });
  const current = new PrismaClient({ datasourceUrl: databaseUrl });
  let id: string | undefined;
  let workspaceId: string | undefined;
  try {
    expect("userProductTourState" in old).toBe(false);
    const user = await old.user.create({ data: { name: "Synthetic legacy", email: "auth-test-tour-legacy@example.invalid", passwordHash: "unused" } });
    id = user.id;
    const workspace = await old.workspace.create({ data: { name: "Synthetic legacy ledger", members: { create: { userId: id, role: "owner" } } } });
    workspaceId = workspace.id;
    await putProductTourState(current, id, "completed");
    expect((await old.user.findUnique({ where: { id }, include: { memberships: true } }))?.memberships).toHaveLength(1);
    expect((await old.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } }))?.members).toHaveLength(1);
    await old.$transaction(async tx => { await tx.workspace.delete({ where: { id: workspaceId } }); await tx.user.delete({ where: { id } }); });
    expect(await current.userProductTourState.count({ where: { userId: id } })).toBe(0);
  } finally {
    if (workspaceId) await old.workspace.deleteMany({ where: { id: workspaceId } });
    if (id) await old.user.deleteMany({ where: { id } });
    await Promise.all([old.$disconnect(), current.$disconnect()]);
    rmSync(temp, { recursive: true, force: true });
  }
}, 40000);
