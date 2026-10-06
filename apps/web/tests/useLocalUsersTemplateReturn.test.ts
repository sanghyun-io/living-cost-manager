import { beforeEach, describe, expect, test, vi } from "vitest";
import { TEMPLATE_SCENARIOS, type TemplateBlueprint } from "@living-cost-manager/shared";
import type { ServerSession } from "../app/lib/serverApi";

// Same minimal hook runner as useServerAuth.test.ts: state/ref slots persist
// across explicit renders, effects are inert, and every side effect is a safe
// in-memory mock. Nothing here talks to a network or real storage, so one
// account's secrets cannot leak into another account's profile by accident.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.slots[index], (action: unknown) => {
      hooks.slots[index] = typeof action === "function" ? action(hooks.slots[index]) : action;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined
}));
vi.mock("../app/lib/analytics", () => ({ track: vi.fn() }));
import { buildTemplateBudget } from "../app/lib/templates";
import { useLocalUsers } from "../app/lib/useLocalUsers";
import { ACTIVE_USER_KEY, USERS_KEY } from "../app/lib/storage";
import { SERVER_SESSION_STORAGE_KEY } from "../app/lib/serverApi";
import { getUserDataKey, getUserErasureKey } from "../app/lib/users";
import { emptyBudgetSnapshot } from "../app/lib/seedData";

const session = (id: string): ServerSession => ({
  token: "secret-token", refreshToken: "secret-refresh", workspace: null,
  user: { id, name: id, email: `${id}@example.com`, emailVerified: true }
} as unknown as ServerSession);

function setup() {
  const storage = new Map<string, string>();
  const confirmMock = vi.fn(() => false);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); }
    },
    confirm: confirmMock
  });
  const auth = {
    serverSession: null as ServerSession | null,
    serverApi: null,
    serverRestoreCheckedRef: { current: true },
    refreshRestoredServerSession: vi.fn(),
    applyBootSession: vi.fn(),
    // Mirrors the real logout: the session pointer and secret are dropped, and
    // never copied into whatever profile becomes active afterwards.
    handleServerLogout: vi.fn(() => { storage.delete(SERVER_SESSION_STORAGE_KEY); auth.serverSession = null; })
  };
  const ui = { closeDataAndManagementModals: vi.fn(), setIsDeleteMode: vi.fn(), setSelectedDeleteIds: vi.fn() };
  hooks.slots = [];
  hooks.cursor = 0;
  const render = () => {
    hooks.cursor = 0;
    return useLocalUsers({ ui, auth, getBudget: () => emptyBudgetSnapshot } as never);
  };
  // Boot an alice profile, apply a template (creating the return pointer),
  // and return the hook whose currentUser is the fresh template space.
  const applyFrom = (blueprint: TemplateBlueprint) => {
    storage.set(USERS_KEY, JSON.stringify([{ id: "alice", name: "Alice" }]));
    storage.set(ACTIVE_USER_KEY, "alice");
    storage.set(getUserDataKey("alice"), JSON.stringify(emptyBudgetSnapshot));
    render().handleLogin("Alice");
    render().setIsLoaded(true);
    render().applyTemplate(blueprint, buildTemplateBudget(blueprint, ["1", "2", "3"], "9"));
    return render();
  };
  return { storage, auth, ui, render, applyFrom, confirmMock };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("returning from a template space is never silent", () => {
  test("plain local profile returns without prompts and restores the pointer", () => {
    const { storage, render, applyFrom } = setup();
    const templateSpace = applyFrom(TEMPLATE_SCENARIOS[0]);
    expect(templateSpace.templateReturnId).toBe("alice");
    expect(render().returnFromTemplate()).toBeNull();
    expect(storage.get(ACTIVE_USER_KEY)).toBe("alice");
    expect(render().currentUser?.id).toBe("alice");
  });

  test("an active server session asks for a confirmed disconnect instead of no-oping", () => {
    const { storage, auth, render, applyFrom, confirmMock } = setup();
    applyFrom(TEMPLATE_SCENARIOS[0]);
    auth.serverSession = session("acct-1");
    const api = render();
    const message = api.returnFromTemplate();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(message).toContain("서버 연결을 유지");
    // Declining keeps the current space, the session, and no logout happens.
    expect(storage.get(ACTIVE_USER_KEY)).toBe(api.currentUser?.id);
    expect(auth.handleServerLogout).not.toHaveBeenCalled();
  });

  test("a confirmed disconnect restores the old profile and copies no secret", () => {
    const { storage, auth, render, applyFrom, confirmMock } = setup();
    const templateSpace = applyFrom(TEMPLATE_SCENARIOS[0]);
    auth.serverSession = session("acct-1");
    storage.set(SERVER_SESSION_STORAGE_KEY, JSON.stringify({ token: "secret-token", refreshToken: "secret-refresh" }));
    confirmMock.mockReturnValue(true);
    expect(templateSpace.returnFromTemplate()).toBeNull();
    expect(auth.handleServerLogout).toHaveBeenCalledOnce();
    expect(storage.get(ACTIVE_USER_KEY)).toBe("alice");
    expect(storage.has(SERVER_SESSION_STORAGE_KEY)).toBe(false);
    for (const value of storage.values()) expect(value).not.toContain("secret-token");
    for (const key of storage.keys()) expect(key).not.toContain("secret");
  });

  test("an erased or removed target profile is never restored and nothing is disconnected for it", () => {
    const { storage, auth, render, applyFrom, confirmMock } = setup();
    const templateSpace = applyFrom(TEMPLATE_SCENARIOS[0]);
    storage.set(getUserErasureKey("alice"), "1");
    storage.delete(getUserDataKey("alice"));
    auth.serverSession = session("acct-1");
    const message = templateSpace.returnFromTemplate();
    expect(message).toContain("삭제되었거나");
    // Validation happens BEFORE any disconnect: no prompt, no logout, no switch.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(auth.handleServerLogout).not.toHaveBeenCalled();
    expect(storage.get(ACTIVE_USER_KEY)).toBe(templateSpace.currentUser?.id);
    expect(auth.serverSession).not.toBeNull();
  });

  test("a cross-tab active pointer change blocks the return", () => {
    const { storage, auth, applyFrom } = setup();
    const templateSpace = applyFrom(TEMPLATE_SCENARIOS[0]);
    storage.set(ACTIVE_USER_KEY, "other-tab-space");
    auth.serverSession = session("acct-1");
    const message = templateSpace.returnFromTemplate();
    expect(message).toContain("활성 공간이 바뀌었습니다");
    expect(storage.get(ACTIVE_USER_KEY)).toBe("other-tab-space");
    expect(auth.handleServerLogout).not.toHaveBeenCalled();
  });

  test("applyTemplate still refuses before the space is loaded", () => {
    const { render } = setup();
    render().handleLogin("Alice");
    expect(() => render().applyTemplate(TEMPLATE_SCENARIOS[0], buildTemplateBudget(TEMPLATE_SCENARIOS[0], ["1", "2", "3"], "9"))).toThrow("불러온 뒤");
  });
});
