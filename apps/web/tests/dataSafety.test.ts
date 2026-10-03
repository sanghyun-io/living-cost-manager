import { expect, test } from "vitest";
import { createServerLocalUser, createUser, resolveStartupUser } from "../app/lib/users";
import { buildLivingCostBackup, parseLivingCostBackup } from "../app/lib/backup";
import { createFixedCost } from "../app/lib/budget";
import { parseFixedCostCsvTemplate } from "../app/lib/budgetImportExport";
import { parseBudgetSnapshot } from "../app/lib/storage";

test("legacy authenticated profile retains its storage identity and gains stable account binding", () => {
  const old = createUser("Alice");
  const serverUser = { id: "account-1", name: "Alice", email: "alice@example.test" };
  const result = resolveStartupUser({ users: [old], activeUserId: old.id, serverUser });
  expect(result.user).toEqual({ ...old, serverUserId: "account-1" });
  expect(resolveStartupUser({ users: result.users, activeUserId: "other", serverUser: { ...serverUser, name: "Renamed" } }).user.id).toBe(old.id);
  expect(createServerLocalUser({ ...serverUser, id: "account-2" }).id).not.toBe(old.id);
});

test("another account never adopts an already-linked same-name profile", () => {
  const old = { ...createUser("Alice"), serverUserId: "account-1" };
  expect(resolveStartupUser({ users: [old], activeUserId: old.id,
    serverUser: { id: "account-2", name: "Alice", email: "another@example.test" } }).user.id).toBe("server:account-2");
});

test("unrelated CSV and truncated backups cannot replace a budget", () => {
  for (const csv of ["unrelated,header\na,b", "항목,금액\n\"잘린 항목", "항목,금액\n이름만", "항목,금액\n,garbage"]) {
    expect(() => parseFixedCostCsvTemplate({ csv, categories: [], cards: [] })).toThrow();
  }
  for (const backup of ["LCM1", "LCM1\n[income]\nmonthlyIncome\t0"]) expect(() => parseLivingCostBackup(backup)).toThrow();
  const backup = buildLivingCostBackup({ monthlyIncome: 0, categories: [], cards: [], fixedCosts: [createFixedCost({ id: "annual", name: "Annual", amount: 120000, billingDay: 1, periodMonths: 12 })] });
  const lines = backup.split("\n");
  lines[lines.length - 1] = lines.at(-1)!.split("\t").slice(0, 7).join("\t");
  expect(() => parseLivingCostBackup(lines.join("\n"))).toThrow();
});

test("corrupt data recovery never inserts sample financial records", () => {
  const result = parseBudgetSnapshot(JSON.stringify({ fixedCosts: [{ billingAnchorDate: "2026-02-30" }] }));
  expect(result.recovered).toBe(true);
  expect(result.snapshot.fixedCosts).toEqual([]);
  expect(result.snapshot.monthlyIncome).toBe(0);
});
