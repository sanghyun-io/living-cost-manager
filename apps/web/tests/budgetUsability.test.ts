import { beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => unknown)[] }));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (action: any) => { hooks.slots[index] = typeof action === "function" ? action(hooks.slots[index]) : action; }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); }
}));
vi.mock("../app/lib/analytics", () => ({ track: vi.fn() }));
import { useBudgetData } from "../app/lib/useBudgetData";
import { getUserDataKey } from "../app/lib/users";
import { buildLivingCostBackup } from "../app/lib/backup";

export function setupBudget() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
  vi.stubGlobal("window", { localStorage: storage, addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: () => true });
  const users = { currentUser: { id: "test-local" }, isBootLoaded: true, isLoaded: true, setIsLoaded: vi.fn() };
  const ui = { categoryFilterId: "all", selectedDeleteIds: [] as string[], setCategoryFilterId: vi.fn(), setSelectedDeleteIds: vi.fn(), setIsDeleteMode: vi.fn(), setImportMessage: vi.fn() };
  const render = () => { hooks.cursor = 0; hooks.effects = []; return useBudgetData({ users, ui } as any); };
  render(); hooks.effects[1]();
  return { render, users, ui, storage, values, save: () => hooks.effects[2]() };
}
beforeEach(() => { hooks.slots = []; vi.unstubAllGlobals(); });
test("import validates before preview, cancels without mutation and refuses edited previews", async () => {
  const h = setupBudget();
  const original = h.render().currentBudgetSnapshot;
  const target = { ...original, monthlyIncome: 555 };
  const file = { text: async () => buildLivingCostBackup(target) } as File;
  await h.render().handleImportBackup({ text: async () => "broken" } as File);
  expect(h.render().pendingImport).toBeNull();
  await h.render().handleImportBackup(file);
  expect(h.render().pendingImport?.snapshot.monthlyIncome).toBe(555);
  expect(h.render().monthlyIncome).toBe(original.monthlyIncome);
  h.render().cancelImport(); h.render().applyImport();
  expect(h.render().monthlyIncome).toBe(original.monthlyIncome);
  await h.render().handleImportBackup(file);
  h.render().handleIncomeChange(888); h.render().applyImport();
  expect(h.render().monthlyIncome).toBe(888);
  await h.render().handleImportBackup(file); h.render().applyImport();
  expect(h.render().monthlyIncome).toBe(555);
  expect([...h.values.keys()].some(key => key.includes(":recovery:"))).toBe(true);
});
test("slow files, cancellation, profile round trips and newer file selection cannot race", async () => {
  const h = setupBudget();
  const text = buildLivingCostBackup({ ...h.render().currentBudgetSnapshot, monthlyIncome: 123 });
  let resolve!: (text: string) => void;
  const slow = () => ({ text: () => new Promise<string>(yes => { resolve = yes; }) } as File);
  let request = h.render().handleImportBackup(slow());
  h.render().cancelImport(); resolve(text); await request;
  expect(h.render().pendingImport).toBeNull();
  request = h.render().handleImportBackup(slow());
  h.users.currentUser = { id: "other" }; h.render();
  h.users.currentUser = { id: "test-local" }; h.render();
  resolve(text); await request;
  expect(h.render().pendingImport).toBeNull();
  request = h.render().handleImportBackup(slow());
  await h.render().handleImportBackup({ text: async () => "bad" } as File);
  resolve(text); await request;
  expect(h.render().pendingImport).toBeNull();
});
test("same-tick edits invalidate import before React renders, even if reverted", async () => {
  const h = setupBudget();
  const before = h.render().currentBudgetSnapshot;
  await h.render().handleImportBackup({ text: async () => buildLivingCostBackup({ ...before, monthlyIncome: 999 }) } as File);
  const b = h.render();
  b.handleIncomeChange(321);
  b.handleIncomeChange(before.monthlyIncome);
  b.applyImport();
  expect(h.render().monthlyIncome).toBe(before.monthlyIncome);
  expect(h.render().pendingImport).toBeNull();
});
test("file reads use the latest loaded scope and explain discarded edits without stale messages", async () => {
  const h = setupBudget();
  const text = buildLivingCostBackup(h.render().currentBudgetSnapshot);
  let resolve!: (text: string) => void;
  const slow = () => ({ text: () => new Promise<string>(yes => { resolve = yes; }) } as File);
  h.users.isLoaded = false;
  let request = h.render().handleImportBackup(slow());
  h.users.isLoaded = true; h.render();
  resolve(text); await request;
  expect(h.render().pendingImport).not.toBeNull();
  h.render().cancelImport();
  request = h.render().handleImportBackup(slow());
  h.render().handleIncomeChange(600);
  resolve(text); await request;
  expect(h.ui.setImportMessage).toHaveBeenLastCalledWith(expect.stringContaining("다시 선택"));
  expect(h.render().pendingImport).toBeNull();
});
test("another tab's persisted edit blocks replacement and repeated apply does not report false failure", async () => {
  const h = setupBudget();
  const text = buildLivingCostBackup({ ...h.render().currentBudgetSnapshot, monthlyIncome: 500 });
  const file = { text: async () => text } as File;
  await h.render().handleImportBackup(file);
  h.values.set(getUserDataKey("test-local"), "another-tab-change");
  h.render().applyImport();
  expect(h.render().monthlyIncome).not.toBe(500);
  expect(h.ui.setImportMessage).toHaveBeenLastCalledWith(expect.stringContaining("다른 탭"));
  await h.render().handleImportBackup(file);
  const b = h.render(); b.applyImport(); b.applyImport();
  expect(h.render().monthlyIncome).toBe(500);
  expect(h.ui.setImportMessage).toHaveBeenLastCalledWith(expect.stringContaining("적용했습니다"));
});
test("new and duplicated items reveal a focus target even with filters active", () => {
  const h = setupBudget();
  h.render().setCostFilters({ query: "hidden", method: "all", review: "completed", sort: "amount" });
  h.render().handleAddItem();
  let b = h.render();
  expect(b.visibleFixedCosts.some(x => x.id === b.focusItemId)).toBe(true);
  const first = b.focusItemId!;
  b.handleDuplicateItem(first); b = h.render();
  expect(b.focusItemId).not.toBe(first);
  expect(b.visibleFixedCosts.some(x => x.id === b.focusItemId)).toBe(true);
});
test("invalid quick input never creates a placeholder row", () => {
  const h = setupBudget();
  const before = h.render().fixedCosts;
  expect(h.render().handleQuickAdd("금액 없음")).toBe(false);
  expect(h.render().fixedCosts).toEqual(before);
});

test("undo merges deleted rows without reverting later edits; replacement and profiles invalidate it", () => {
  const h = setupBudget();
  let b = h.render();
  b.handleAddItem(); b.handleQuickAdd("보험 12000원 매달");
  b = h.render();
  const [first, second] = b.fixedCosts;
  h.ui.selectedDeleteIds = [first.id];
  h.render().handleConfirmDeleteItems();
  b = h.render(); b.handleItemChange(second.id, { amount: 777 });
  h.render().handleUndoDelete();
  b = h.render();
  expect(b.fixedCosts.find(x => x.id === second.id)?.amount).toBe(777);
  expect(b.fixedCosts.filter(x => x.id === first.id)).toHaveLength(1);
  b.handleConfirmDeleteItems(); b = h.render();
  h.users.currentUser = { id: "other" };
  h.render().handleUndoDelete();
  expect(h.render().fixedCosts.some(x => x.id === first.id)).toBe(false);
  h.users.currentUser = { id: "test-local" };
  b = h.render(); b.applyBudgetSnapshot({ ...b.currentBudgetSnapshot, fixedCosts: [] });
  h.render().handleUndoDelete();
  expect(h.render().fixedCosts).toEqual([]);
});

test("quota failure retains edits and retry persists latest state; recovery remains blocked", () => {
  const h = setupBudget();
  let budget = h.render();
  budget.handleIncomeChange(765432);
  budget = h.render();
  h.storage.setItem.mockImplementationOnce(() => { throw new Error("QuotaExceeded"); });
  h.save();
  budget = h.render();
  expect(budget.saveError).toContain("저장하지 못했습니다");
  expect(budget.monthlyIncome).toBe(765432);
  budget.retrySave(); h.render(); h.save();
  expect(h.render().saveError).toBe("");
  expect(JSON.parse(h.values.get(getUserDataKey("test-local"))!).monthlyIncome).toBe(765432);
  h.users.currentUser = { id: "other" };
  h.render(); h.save();
  expect(h.values.has(getUserDataKey("other"))).toBe(false);
});
