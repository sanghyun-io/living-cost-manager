import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import type { ServerSession } from "../app/lib/serverApi";

// Minimal hook runner: retain state/ref slots across explicit renders. Async
// requests are real deferred promises so we control the response ordering.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
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
const api = vi.hoisted(() => ({
  login: vi.fn(), logout: vi.fn(), me: vi.fn(), refresh: vi.fn(), deleteAccount: vi.fn()
}));
vi.mock("../app/lib/serverApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../app/lib/serverApi")>(),
  createServerApiClient: () => api,
  resolveServerSessionWorkspace: async (_api: unknown, session: ServerSession) => session
}));
vi.mock("../app/lib/analytics", () => ({ clearEvents: vi.fn().mockResolvedValue(undefined) }));
import { useServerAuth } from "../app/lib/useServerAuth";
import { SERVER_SESSION_STORAGE_KEY, ServerApiError } from "../app/lib/serverApi";
import { clearEvents } from "../app/lib/analytics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const session = (id: string): ServerSession => ({
  token: id, refreshToken: id + "-refresh", workspace: null,
  user: { id, name: id, email: `${id}@example.com`, emailVerified: true }
} as ServerSession);

function setup() {
  const users = { currentUser: { id: "alice-local", name: "Alice" },
    knownUsers: [{ id: "alice-local", name: "Alice", serverUserId: "alice" }],
    handleLogin: vi.fn(), handleAccountDeleted: vi.fn() };
  const sync = {
    setIsServerSnapshotChecked: vi.fn(), loadServerWorkspaces: vi.fn().mockResolvedValue(undefined),
    prepareServerSyncDecision: vi.fn().mockResolvedValue(undefined), refreshSharing: vi.fn().mockResolvedValue(undefined),
    resetOnServerLogout: vi.fn(), dropSessionOnAuthFailure: vi.fn()
  };
  const ui = { isAuthModalOpen: false, setIsAuthModalOpen: vi.fn(), setIsDataModalOpen: vi.fn() };
  const render = () => {
    hooks.cursor = 0;
    return useServerAuth({ ui, getUsers: () => users, getSync: () => sync } as unknown as Parameters<typeof useServerAuth>[0]);
  };
  return { users, sync, ui, render };
}

beforeEach(() => {
  hooks.slots = [];
  vi.clearAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  } });
  api.logout.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("stale auth responses", () => {
  test("the most recent login wins even when the old login responds last", async () => {
    const { render, users } = setup();
    const first = deferred<ServerSession>();
    const second = deferred<ServerSession>();
    api.login.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const auth = render();
    const values = { mode: "login" as const, email: "a@example.com", password: "password123", name: "" };
    const oldLogin = auth.handleServerAuthSubmit(values);
    const newLogin = auth.handleServerAuthSubmit(values);
    second.resolve(session("bob"));
    expect(await newLogin).toBe(true);
    first.resolve(session("alice"));
    expect(await oldLogin).toBe(false);
    expect(render().serverSession?.token).toBe("bob");
    expect(users.handleLogin).toHaveBeenCalledExactlyOnceWith("bob", "server", expect.objectContaining({ id: "bob" }));
  });

  test("logout during workspace loading prevents follow-up sync and any second local login", async () => {
    const { render, users, sync } = setup();
    const loading = deferred<void>();
    const entered = deferred<void>();
    sync.loadServerWorkspaces.mockImplementationOnce(() => { entered.resolve(); return loading.promise; });
    api.login.mockResolvedValueOnce(session("alice"));
    const auth = render();
    const login = auth.handleServerAuthSubmit({ mode: "login", email: "a@example.com", password: "password123", name: "" });
    await entered.promise;
    auth.handleServerLogout();
    loading.resolve();
    expect(await login).toBe(false);
    expect(sync.prepareServerSyncDecision).not.toHaveBeenCalled();
    expect(users.handleLogin).toHaveBeenCalledExactlyOnceWith("alice", "server", expect.objectContaining({ id: "alice" }));
    expect(render().serverSession).toBeNull();
  });
  test("failure after committing a login cannot delete the previously active local profile", async () => {
    const { render, users, sync } = setup();
    api.login.mockResolvedValueOnce(session("bob"));
    sync.loadServerWorkspaces.mockRejectedValueOnce(new Error("offline"));
    const auth = render();
    expect(await auth.handleServerAuthSubmit({ mode: "login", email: "b@example.com", password: "password123", name: "" })).toBe(false);
    expect(users.handleLogin).toHaveBeenCalledWith("bob", "server", expect.objectContaining({ id: "bob" }));
    // Even with the test runner retaining Alice as currentUser, deletion uses Bob's identity.
    api.deleteAccount.mockResolvedValueOnce(undefined);
    await render().handleDeleteAccount("password123");
    expect(users.handleAccountDeleted).toHaveBeenCalledWith("server:bob");
  });
  test("logout invalidates a pending login before it can restore storage or local identity", async () => {
    const { render, users } = setup();
    const pending = deferred<ServerSession>();
    api.login.mockReturnValueOnce(pending.promise);
    const auth = render();
    const login = auth.handleServerAuthSubmit({ mode: "login", email: "a@example.com", password: "password123", name: "" });
    auth.handleServerLogout();
    pending.resolve(session("alice"));
    expect(await login).toBe(false);
    expect(render().serverSession).toBeNull();
    expect(window.localStorage.getItem(SERVER_SESSION_STORAGE_KEY)).toBeNull();
    expect(users.handleLogin).not.toHaveBeenCalled();
  });

  test("late boot refresh cannot overwrite a newer session", async () => {
    const { render } = setup();
    const pending = deferred<ServerSession>();
    api.me.mockRejectedValueOnce(new ServerApiError("Invalid token", 401));
    api.refresh.mockReturnValueOnce(pending.promise);
    const auth = render();
    auth.applyBootSession(session("alice"));
    const restore = auth.refreshRestoredServerSession(session("alice"));
    await Promise.resolve();
    auth.setServerSession(session("bob"));
    auth.saveServerSession(session("bob"));
    pending.resolve(session("refreshed-alice"));
    await restore;
    expect(render().serverSession?.token).toBe("bob");
    expect(JSON.parse(window.localStorage.getItem(SERVER_SESSION_STORAGE_KEY)!).token).toBe("bob");
  });

  test("deletion cleans the captured local user while preserving a newer server session", async () => {
    const { render, users, sync, ui } = setup();
    const pending = deferred<void>();
    api.deleteAccount.mockReturnValueOnce(pending.promise);
    const auth = render();
    auth.applyBootSession(session("alice"));
    const deletion = auth.handleDeleteAccount("password123");
    users.currentUser = { id: "bob-local", name: "Bob" };
    auth.setServerSession(session("bob"));
    auth.saveServerSession(session("bob"));
    pending.resolve();
    expect(await deletion).toBe("deleted");
    expect(users.handleAccountDeleted).toHaveBeenCalledWith("alice-local");
    expect(clearEvents).toHaveBeenCalled();
    expect(render().serverSession?.token).toBe("bob");
    expect(JSON.parse(window.localStorage.getItem(SERVER_SESSION_STORAGE_KEY)!).token).toBe("bob");
    expect(sync.resetOnServerLogout).not.toHaveBeenCalled();
    expect(ui.setIsAuthModalOpen).not.toHaveBeenCalled();
  });

  test.each(["Invalid credentials", "Invalid token"])("deletion distinguishes %s", async (message) => {
    const { render, sync } = setup();
    const auth = render();
    auth.applyBootSession(session("alice"));
    api.deleteAccount.mockRejectedValueOnce(new ServerApiError(message, 401));
    expect(await auth.handleDeleteAccount("password123")).toBe("error");
    expect(render().serverSession?.token ?? null).toBe(message === "Invalid credentials" ? "alice" : null);
    expect(sync.dropSessionOnAuthFailure).toHaveBeenCalledTimes(message === "Invalid token" ? 1 : 0);
  });

  test("late deletion auth failure does not disconnect a newer session", async () => {
    const { render, sync } = setup();
    const pending = deferred<void>();
    api.deleteAccount.mockReturnValueOnce(pending.promise);
    const auth = render();
    auth.applyBootSession(session("alice"));
    const deletion = auth.handleDeleteAccount("password123");
    auth.setServerSession(session("bob"));
    pending.reject(new ServerApiError("Invalid token", 401));
    expect(await deletion).toBe("error");
    expect(render().serverSession?.token).toBe("bob");
    expect(sync.dropSessionOnAuthFailure).not.toHaveBeenCalled();
  });
});
