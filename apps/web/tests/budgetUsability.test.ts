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
