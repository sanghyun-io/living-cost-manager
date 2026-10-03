import { expect, test } from "vitest";
import { createFixedCost, updateFixedCost, DEFAULT_CATEGORIES } from "../app/lib/budget";
import { buildLivingCostBackup, parseLivingCostBackup } from "../app/lib/backup";
import { buildFixedCostCsvTemplate, parseFixedCostCsvTemplate } from "../app/lib/budgetImportExport";
import { buildSnapshotKey, buildWorkspaceSnapshot, hydrateWorkspaceSnapshot } from "../app/lib/snapshot";
import { parseBudgetSnapshot } from "../app/lib/storage";
import { workspaceSnapshotSchema } from "@living-cost-manager/shared";

const item = createFixedCost({ id: "annual", name: "Annual", categoryId: "other", amount: 120000, billingDay: 1,
  periodMonths: 12, billingAnchorDate: "2024-02-29", renewalStatus: "completed", potentialMonthlySavings: 9000, confirmedMonthlySavings: 3000 });
const snapshot = { monthlyIncome: 1000000, categories: DEFAULT_CATEGORIES, cards: [], fixedCosts: [item] };

test("billing fields survive storage, backup, CSV and API snapshot round trips", () => {
  expect(parseBudgetSnapshot(JSON.stringify(snapshot)).snapshot.fixedCosts).toEqual([item]);
  expect(parseLivingCostBackup(buildLivingCostBackup(snapshot)).fixedCosts).toEqual([item]);
  expect(parseFixedCostCsvTemplate({ csv: buildFixedCostCsvTemplate(snapshot), categories: DEFAULT_CATEGORIES, cards: [] }).fixedCosts).toEqual([item]);
  const api = workspaceSnapshotSchema.parse(buildWorkspaceSnapshot("workspace", snapshot));
  expect(hydrateWorkspaceSnapshot(api).fixedCosts).toEqual([item]);
});

test("schedule and renewal edits change snapshot identity", () => {
  for (const patch of [{ billingAnchorDate: "2026-05-01" }, { isEndOfMonth: true }, { confirmedMonthlySavings: 1 }, { renewalStatus: "keep" as const }]) {
    expect(buildSnapshotKey({ ...snapshot, fixedCosts: [updateFixedCost(item, patch)] })).not.toBe(buildSnapshotKey(snapshot));
  }
});

test("legacy records stay unknown, reopening review clears confirmed savings", () => {
  const legacy = createFixedCost({ id: "old", name: "Old", amount: 1000, billingDay: 10 });
  expect(legacy.billingAnchorDate).toBeNull();
  expect(updateFixedCost(item, { renewalStatus: "change-review" }).confirmedMonthlySavings).toBe(0);
  expect(() => updateFixedCost(item, { billingAnchorDate: "2026-02-30" })).toThrow();
  expect(() => createFixedCost({ ...item, renewalStatus: "cancel-planned", confirmedMonthlySavings: 10 })).toThrow();
});
