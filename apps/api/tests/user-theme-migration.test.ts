import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "vitest";

import { resolveApiTestDatabaseUrl } from "./test-database.js";

// All writes go to the explicitly gated local ephemeral test DB (never load .env).
// Prisma MODEL calls are deliberately avoided against the isolated copy schema:
// before the ALTER it does not match the generated client, so raw SQL only.
const databaseUrl = resolveApiTestDatabaseUrl();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migration = readFileSync(path.join(root, "prisma/migrations/20261020120000_add_user_ui_theme/migration.sql"), "utf8");
const pgBin = process.env.LCM_CI_PG_BIN_DIR ?? "/opt/homebrew/opt/postgresql@16/bin";

test("exact additive ALTER: bounded lock abort leaves the column absent and rows unchanged; apply, CHECK enforcement, old-binary insert and dump/restore rehearsal", async () => {
  const schema = "user_theme_migration_test";
  const restoredSchema = "user_theme_restore_test";
  const url = new URL(databaseUrl); url.searchParams.set("schema", schema);
  const source = new PrismaClient({ datasourceUrl: databaseUrl });
  const current = new PrismaClient({ datasourceUrl: url.toString() });
  const locking = new PrismaClient({ datasourceUrl: url.toString() });
  const psqlUrl = new URL(url); psqlUrl.searchParams.delete("schema"); psqlUrl.searchParams.set("options", `-csearch_path=${schema} -clc_messages=C`);
  const connection = psqlUrl.toString().replaceAll("+", "%20");
  const run = (sql: string) => execFileSync(path.join(pgBin, "psql"), ["-X", "--set", "ON_ERROR_STOP=1", "--dbname", connection], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  let release!: () => void; let ready!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { ready = resolve; });
  let held: Promise<unknown> | undefined;
  try {
    // Idempotent self-heal of this test's own synthetic schemas only (a hard
    // client-process kill can skip the finally's DROP).
    await source.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await source.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${restoredSchema}" CASCADE`);
    await source.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await source.$executeRawUnsafe(`CREATE TABLE "${schema}"."User" (LIKE "User" INCLUDING ALL)`);
    // LIKE INCLUDING ALL copies the live column if migrations already ran; build the
    // pre-migration shape on the isolated copy only by removing the target column.
    await current.$executeRawUnsafe('ALTER TABLE "User" DROP COLUMN IF EXISTS "uiTheme"');
    // The copied DDL has no DB default for "updatedAt" (Prisma fills it app-side),
    // so raw inserts supply CURRENT_TIMESTAMP explicitly.
    await current.$executeRawUnsafe(`INSERT INTO "User" ("id","email","name","passwordHash","updatedAt") VALUES ('pre-theme-1','pre-migration-theme@example.invalid','Synthetic pre-migration','unused',CURRENT_TIMESTAMP)`);
    const rowsBefore = await current.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM "User"');
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]).not.toHaveProperty("uiTheme");

    // 1) Bounded abort: with ACCESS EXCLUSIVE held elsewhere, the exact checked-in
    //    SQL must fail on lock_timeout and leave nothing behind (then succeed on retry).
    held = locking.$transaction(async tx => { await tx.$executeRawUnsafe(`LOCK TABLE "${schema}"."User" IN ACCESS EXCLUSIVE MODE`); ready(); await gate; }, { timeout: 60000 });
    await acquired;
    const start = Date.now();
    expect(() => run(migration)).toThrow(/lock timeout/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4900);
    // While the lock is still held, only catalog reads may run: any data SELECT on
    // "User" would itself queue behind ACCESS EXCLUSIVE until the holder expires.
    expect(await current.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'User' AND column_name = 'uiTheme') AS present`
    )).toEqual([{ present: false }]);

    // 2) Apply after release: existing rows read back the approved default.
    release(); await held; held = undefined;
    expect(await current.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM "User"')).toEqual(rowsBefore);
    run(migration);
    expect(await current.$queryRawUnsafe<Array<{ uiTheme: string }>>('SELECT "uiTheme" FROM "User"')).toEqual([{ uiTheme: "jade" }]);

    // 3) The SQL CHECK enforces the approved five at the storage layer too.
    await expect(current.$executeRawUnsafe(`INSERT INTO "User" ("id","email","name","passwordHash","uiTheme","updatedAt") VALUES ('chk-1','chk1@example.invalid','n','h','magenta',CURRENT_TIMESTAMP)`)).rejects.toThrow();
    for (const id of ["jade", "aqua", "violet", "raspberry", "tangerine"]) {
      await current.$executeRawUnsafe(`INSERT INTO "User" ("id","email","name","passwordHash","uiTheme","updatedAt") VALUES ('chk-${id}','${id}@theme-check.example.invalid','n','h','${id}',CURRENT_TIMESTAMP)`);
    }

    // 4) Old-binary compatibility (production rollback keeps the column): a
    //    pre-theme INSERT omitting uiTheme still works via the constant default.
    await current.$executeRawUnsafe(`INSERT INTO "User" ("id","email","name","passwordHash","updatedAt") VALUES ('legacy-1','legacy1@example.invalid','n','h',CURRENT_TIMESTAMP)`);
    expect(await current.$queryRawUnsafe<Array<{ uiTheme: string }>>('SELECT "uiTheme" FROM "User" WHERE "id" = \'legacy-1\'')).toEqual([{ uiTheme: "jade" }]);

    // 5) Dump/restore rehearsal on synthetic data only: column, default and CHECK
    //    survive a pg_dump round trip into a separate disposable schema.
    const dump = execFileSync(path.join(pgBin, "pg_dump"), ["--dbname", connection, "--schema", schema, "--no-owner", "--no-privileges"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    run(dump.replaceAll(schema, restoredSchema));
    expect(await current.$queryRawUnsafe<Array<{ uiTheme: string }>>(`SELECT "uiTheme" FROM "${restoredSchema}"."User" WHERE "id" = 'legacy-1'`)).toEqual([{ uiTheme: "jade" }]);
    await expect(current.$executeRawUnsafe(`INSERT INTO "${restoredSchema}"."User" ("id","email","name","passwordHash","uiTheme","updatedAt") VALUES ('x','x@x.invalid','n','h','magenta',CURRENT_TIMESTAMP)`)).rejects.toThrow();
  } finally {
    release(); if (held) await held.catch(() => undefined);
    // Only synthetic schemas created by this test, never application migration rollback.
    await source.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${restoredSchema}" CASCADE`);
    await source.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.all([source.$disconnect(), current.$disconnect(), locking.$disconnect()]);
  }
}, 90000);
