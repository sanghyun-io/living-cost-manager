import { describe, expect, test } from "vitest";

import { cleanupLocalAccountData, removeLocalUser } from "../app/lib/account";
import {
  ACTIVE_USER_KEY,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  USERS_KEY
} from "../app/lib/storage";
import { SERVER_SESSION_STORAGE_KEY } from "../app/lib/serverApi";
import { getUserDataKey, type AppUser } from "../app/lib/users";

// Local-data half of account deletion. The storage contract lives in
// app/lib/account.ts (pure over an injected storage), so these run without a
// DOM.

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    snapshot: () => Object.fromEntries(data)
  };
}

const alice: AppUser = { id: "alice", name: "Alice" };
const bob: AppUser = { id: "bob", name: "Bob" };

function usersJson(users: AppUser[]) {
  return JSON.stringify(users);
}

describe("removeLocalUser", () => {
  test("removes only the target user", () => {
    expect(removeLocalUser([alice, bob], "alice")).toEqual([bob]);
  });

  test("unknown id is a no-op", () => {
    expect(removeLocalUser([alice, bob], "charlie")).toEqual([alice, bob]);
  });
});

describe("cleanupLocalAccountData", () => {
  test("removes recovery copies only for the deleted ID and preserves a newer session and active user", () => {
    const charlie = { id: "charlie", name: "Charlie" };
    const storage = memoryStorage({
      [USERS_KEY]: usersJson([alice, bob, charlie]),
      [ACTIVE_USER_KEY]: "charlie",
      [SERVER_SESSION_STORAGE_KEY]: "new-session",
      [getUserDataKey("alice") + ":corrupt:123"]: "private",
      [getUserDataKey("alice") + ":recovery:456"]: "private",
      [getUserDataKey("bob") + ":corrupt:123"]: "keep"
    });
    const result = cleanupLocalAccountData(storage, "alice", { clearServerSession: false });
    expect(result.activeUserId).toBe("charlie");
    expect(storage.getItem(SERVER_SESSION_STORAGE_KEY)).toBe("new-session");
    expect(storage.getItem(getUserDataKey("alice") + ":corrupt:123")).toBeNull();
    expect(storage.getItem(getUserDataKey("alice") + ":recovery:456")).toBeNull();
    expect(storage.getItem(getUserDataKey("bob") + ":corrupt:123")).toBe("keep");
  });
  test("drops the user entry, per-user data, legacy snapshot and server session", () => {
    const storage = memoryStorage({
      [USERS_KEY]: usersJson([alice, bob]),
      [getUserDataKey("alice")]: '{"monthlyIncome":1}',
      [getUserDataKey("bob")]: '{"monthlyIncome":2}',
      [STORAGE_KEY]: '{"monthlyIncome":99}',
      [LEGACY_STORAGE_KEY]: "stale",
      [SERVER_SESSION_STORAGE_KEY]: JSON.stringify({ token: "jwt", refreshToken: "r", user: alice, workspace: null }),
      [ACTIVE_USER_KEY]: "alice"
    });

    const result = cleanupLocalAccountData(storage, "alice");

    expect(result.remainingUsers).toEqual([bob]);
    expect(result.activeUserId).toBe("bob");
    expect(JSON.parse(storage.getItem(USERS_KEY)!)).toEqual([bob]);
    // The deleted account's budget data is gone; the other user's survives.
    expect(storage.getItem(getUserDataKey("alice"))).toBeNull();
    expect(storage.getItem(getUserDataKey("bob"))).toBe('{"monthlyIncome":2}');
    // Legacy (pre per-user-key) snapshots may still hold the deleted account's
    // data — removed per the GDPR cleanup requirement.
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(SERVER_SESSION_STORAGE_KEY)).toBeNull();
    // Active pointer switched to the remaining user.
    expect(storage.getItem(ACTIVE_USER_KEY)).toBe("bob");
  });

  test("clears the active pointer when the deleted user was the only one", () => {
    const storage = memoryStorage({
      [USERS_KEY]: usersJson([alice]),
      [getUserDataKey("alice")]: "data",
      [ACTIVE_USER_KEY]: "alice"
    });

    const result = cleanupLocalAccountData(storage, "alice");

    expect(result.remainingUsers).toEqual([]);
    expect(result.activeUserId).toBeNull();
    expect(storage.getItem(USERS_KEY)).toBe("[]");
    expect(storage.getItem(ACTIVE_USER_KEY)).toBeNull();
    expect(storage.getItem(getUserDataKey("alice"))).toBeNull();
  });

  test("tolerates missing/corrupt user registry", () => {
    const missing = memoryStorage();
    expect(cleanupLocalAccountData(missing, "ghost")).toEqual({
      remainingUsers: [],
      activeUserId: null
    });

    const corrupt = memoryStorage({ [USERS_KEY]: "{not json" });
    expect(cleanupLocalAccountData(corrupt, "ghost").remainingUsers).toEqual([]);

    const malformed = memoryStorage({
      [USERS_KEY]: JSON.stringify([{ id: "keep", name: "Keep" }, { name: "no id" }, null, alice])
    });
    const result = cleanupLocalAccountData(malformed, "alice");
    expect(result.remainingUsers).toEqual([{ id: "keep", name: "Keep" }]);
  });

  test("removing an unknown id keeps other users' entries intact", () => {
    const storage = memoryStorage({ [USERS_KEY]: usersJson([alice, bob]) });

    const result = cleanupLocalAccountData(storage, "charlie");

    expect(result.remainingUsers).toEqual([alice, bob]);
    expect(result.activeUserId).toBe("alice");
  });
});
