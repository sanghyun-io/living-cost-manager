import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Dependency-aware synchronous hook harness. State/ref/memo slots survive renders;
// effects run after commit and changed state triggers another explicit render.
// No budget, persistence, classification, consent or transport code is mocked.
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (action: any) => {
      const next = typeof action === "function" ? action(hooks.slots[index]) : action;
      if (!Object.is(next, hooks.slots[index])) { hooks.slots[index] = next; hooks.dirty = true; }
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useMemo(factory: () => unknown, deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) hooks.slots[index] = { deps, value: factory() };
    return hooks.slots[index].value;
  },
  useEffect(effect: () => void | (() => void), deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hooks.slots[index] = { deps, cleanup: previous?.cleanup };
      hooks.effects.push(() => { previous?.cleanup?.(); hooks.slots[index].cleanup = effect(); });
    }
  }
}));
vi.mock("../app/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../app/lib/serverApi", () => ({ getServerApiBaseUrl: () => "https://api.example.test/v1" }));
import { useBudgetData } from "../app/lib/useBudgetData";
import { track } from "../app/lib/analytics";
import { __resetMarketingConsentMemoryForTests, enableMarketingConsent } from "../app/lib/marketingConsent";
import { disableMarketing } from "../app/lib/marketing";
import { getUserDataKey } from "../app/lib/users";
import { emptyBudgetSnapshot } from "../app/lib/seedData";
import { buildLivingCostBackup } from "../app/lib/backup";
import { createFixedCost } from "../app/lib/budget";

let values: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.dirty = false;
  vi.clearAllMocks(); __resetMarketingConsentMemoryForTests();
  values = new Map([[getUserDataKey("local-a"), JSON.stringify(emptyBudgetSnapshot)]]);
  storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: vi.fn((key: string) => { values.delete(key); }) };
  vi.stubGlobal("window", { localStorage: storage, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(async () => {
  for (const slot of hooks.slots) slot?.cleanup?.();
  disableMarketing(); await flush(); vi.unstubAllGlobals();
});

function setup(options: { personal?: boolean; sample?: boolean; boot?: boolean } = {}) {
  const users = { currentUser: { id: "local-a", name: "Local", serverUserId: undefined as string | undefined }, isSampleMode: options.sample ?? false, isBootLoaded: options.boot ?? true,
    isLoaded: false, setIsLoaded(value: boolean) { if (users.isLoaded !== value) { users.isLoaded = value; hooks.dirty = true; } } };
  const ui = { categoryFilterId: "all", selectedDeleteIds: [], setCategoryFilterId: vi.fn(), setIsDeleteMode: vi.fn(), setSelectedDeleteIds: vi.fn(), setImportMessage: vi.fn() };
  let personal = options.personal ?? true;
  function render() {
    let result!: ReturnType<typeof useBudgetData>;
    let count = 0;
    do {
      if (++count > 30) throw Error("Hook harness did not settle");
      hooks.dirty = false; hooks.cursor = 0;
      result = useBudgetData({ users, ui, marketingPersonal: personal } as unknown as Parameters<typeof useBudgetData>[0]);
      const effects = hooks.effects.splice(0);
      for (const effect of effects) effect();
    } while (hooks.dirty);
    return result;
  }
  return { users, ui, render, setPersonal(value: boolean) { personal = value; } };
}
function events() { return vi.mocked(fetch).mock.calls.map(([, options]) => JSON.parse(options!.body as string).event); }

describe("real budget hook marketing integration", () => {
  test("default-off central consent does not disable independent local analytics", async () => {
    const { render } = setup();
    render().handleAddItem(); render(); await flush();
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ type: "budget.fixed_cost_add" }));
    expect(JSON.parse(values.get(getUserDataKey("local-a"))!).fixedCosts).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    enableMarketingConsent(); render().retrySave(); render(); await flush();
    expect(fetch).not.toHaveBeenCalled(); // enabling never backfills historical activity
  });
  test("explicit cost, billing and renewal actions signal only after successful local persistence", async () => {
    enableMarketingConsent();
    const { render } = setup();
    render().handleQuickAdd("넷플릭스 17000원 매달");
    await flush(); expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(values.get(getUserDataKey("local-a"))!).fixedCosts).toHaveLength(0);
    let budget = render(); await flush();
    expect(events()).toEqual(["personal_cost_saved"]);
    const id = budget.fixedCosts[0].id;
    budget.handleItemChange(id, { billingAnchorDate: "2026-10-05", renewalStatus: "keep" });
    await flush(); expect(fetch).toHaveBeenCalledTimes(1);
    budget = render(); await flush();
    const saved = JSON.parse(values.get(getUserDataKey("local-a"))!).fixedCosts[0];
    expect(saved).toMatchObject({ billingAnchorDate: "2026-10-05", renewalStatus: "keep" });
    expect(events()).toEqual(["personal_cost_saved", "personal_billing_date_saved", "personal_renewal_decision_saved"]);
    budget.handleItemChange(id, { billingAnchorDate: "2026-10-05", renewalStatus: "keep" });
    render(); await flush(); expect(fetch).toHaveBeenCalledTimes(3);
  });
  test("blank Add does not consume the milestone; valid Quick Add waits for persistence", async () => {
    enableMarketingConsent(); const { render } = setup();
    render().handleAddItem(); render(); await flush(); expect(fetch).not.toHaveBeenCalled();
    expect(render().handleQuickAdd("")).toBe(false);
    render(); await flush(); expect(fetch).not.toHaveBeenCalled();
    expect(render().handleQuickAdd("넷플릭스 17000원 매달")).toBe(true);
    await flush(); expect(fetch).not.toHaveBeenCalled();
    render(); await flush(); expect(events()).toEqual(["personal_cost_saved"]);
  });
  test.each([{ sample: true }, { personal: false }, { boot: false }])("sample/shared/unready context %j excluded", async (options) => {
    enableMarketingConsent(); const { render } = setup(options);
    render().handleQuickAdd("넷플릭스 17000원 매달"); render(); await flush(); expect(fetch).not.toHaveBeenCalled();
  });
  test("failed budget write drops signal permanently, even when explicit save retry succeeds", async () => {
    enableMarketingConsent(); const { render } = setup(); const budget = render();
    const key = getUserDataKey("local-a");
    storage.setItem.mockImplementation((name: string, value: string) => { if (name === key) throw Error("quota"); values.set(name, value); });
    budget.handleQuickAdd("넷플릭스 17000원 매달");
    expect(render().saveError).not.toBe(""); await flush(); expect(fetch).not.toHaveBeenCalled();
    storage.setItem.mockImplementation((name: string, value: string) => { values.set(name, value); });
    render().retrySave(); expect(render().saveError).toBe(""); await flush();
    expect(JSON.parse(values.get(key)!).fixedCosts).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  test("queued action is discarded on profile change before persistence", async () => {
    enableMarketingConsent(); const { render, users } = setup(); render().handleQuickAdd("넷플릭스 17000원 매달");
    users.currentUser = { id: "local-b", name: "Other", serverUserId: undefined };
    values.set(getUserDataKey("local-b"), JSON.stringify(emptyBudgetSnapshot));
    render(); await flush(); expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(values.get(getUserDataKey("local-b"))!).fixedCosts).toHaveLength(0);
  });
  test("queued action is discarded on consent scope or context change", async () => {
    enableMarketingConsent(); const { render, setPersonal } = setup(); render().handleQuickAdd("넷플릭스 17000원 매달");
    disableMarketing(); enableMarketingConsent(); render(); await flush();
    expect(fetch).not.toHaveBeenCalled();
    render().handleQuickAdd("넷플릭스 17000원 매달"); setPersonal(false); render(); await flush();
    expect(fetch).not.toHaveBeenCalled();
    setPersonal(true); render().retrySave(); render(); await flush(); expect(fetch).not.toHaveBeenCalled();
  });
  test("server-linked profile is excluded even when caller says personal and no workspace exists", async () => {
    enableMarketingConsent(); const { render, users } = setup();
    users.currentUser.serverUserId = "server-account";
    render().handleQuickAdd("넷플릭스 17000원 매달"); render(); await flush();
    expect(JSON.parse(values.get(getUserDataKey("local-a"))!).fixedCosts).toHaveLength(0);
    const guest = render().localScopeKey!;
    expect(guest).toMatch(/^guest:/);
    expect(JSON.parse(values.get(getUserDataKey(guest))!).fixedCosts).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  test("hydration and sync snapshot application never generate events or replay queued saves", async () => {
    enableMarketingConsent();
    const historical = { ...emptyBudgetSnapshot, fixedCosts: [createFixedCost({ id: "past", name: "Private name", amount: 100, billingDay: 1, billingAnchorDate: "2026-10-01", renewalStatus: "keep" })] };
    values.set(getUserDataKey("local-a"), JSON.stringify(historical));
    const { render } = setup(); const budget = render(); await flush(); expect(fetch).not.toHaveBeenCalled();
    budget.handleQuickAdd("넷플릭스 17000원 매달"); budget.applyBudgetSnapshot(historical); render(); await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(values.get(getUserDataKey("local-a"))!).fixedCosts).toHaveLength(1);
  });
  test("real validated backup import writes localStorage without central events", async () => {
    enableMarketingConsent(); const { render } = setup(); const budget = render();
    const snapshot = { ...emptyBudgetSnapshot, fixedCosts: [createFixedCost({ id: "imported", name: "Private import", amount: 123, billingDay: 1, billingAnchorDate: "2026-10-01", renewalStatus: "keep" })] };
    const file = { text: async () => buildLivingCostBackup(snapshot) } as File;
    await budget.handleImportBackup(file);
    const preview = render(); expect(preview.pendingImport).not.toBeNull();
    preview.applyImport(); render(); await flush();
    expect(JSON.parse(values.get(getUserDataKey("local-a"))!).fixedCosts[0].id).toBe("imported");
    expect(fetch).not.toHaveBeenCalled();
  });
  test("changed-back billing does not count as a saved milestone", async () => {
    enableMarketingConsent(); const { render } = setup();
    const budget = render();
    budget.applyBudgetSnapshot({ ...emptyBudgetSnapshot, fixedCosts: [createFixedCost({ id: "one", name: "Existing", amount: 100, billingDay: 1 })] });
    const loaded = render();
    loaded.handleItemChange("one", { billingAnchorDate: "2026-10-05" });
    loaded.handleItemChange("one", { billingAnchorDate: null });
    render(); await flush(); expect(fetch).not.toHaveBeenCalled();
  });
});
