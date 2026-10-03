// Local (browser) side of account deletion. The server hard-deletes the row;
// this module wipes every local trace so GDPR erasure is honest on the device
// too. Pure over an injected storage so it is unit-testable without a DOM.
import {
  ACTIVE_USER_KEY,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  USERS_KEY
} from "./storage";
import { SERVER_SESSION_STORAGE_KEY } from "./serverApi";
import { getUserDataKey, getUserErasureKey, type AppUser } from "./users";

export type StringStorage = {
  readonly length?: number;
  key?(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Removes one user entry; unknown ids are a no-op. */
export function removeLocalUser(users: AppUser[], userId: string): AppUser[] {
  return users.filter((user) => user.id !== userId);
}

export type AccountDataCleanupResult = {
  /** Users that still exist in this browser after the removal. */
  remainingUsers: AppUser[];
  /** User the active pointer was moved to, or null when no user remains. */
  activeUserId: string | null;
};

/**
 * Erases every trace of the deleted account from browser storage:
 *  - `living-cost-manager:users:v1`     → entry for the removed user gone
 *  - `living-cost-manager:user:<id>:v1` → per-user budget data removed
 *  - `living-cost-manager:v2` (+ `:v1`) → legacy snapshot (may still hold the
 *    deleted account's pre-migration data) removed
 *  - `living-cost-manager:server-session:v2` → server tokens gone
 *  - `living-cost-manager:active-user:v1` → switched to another known user,
 *    or cleared when none is left
 */
export function cleanupLocalAccountData(
  storage: StringStorage,
  removedUserId: string,
  options: { clearServerSession?: boolean } = {}
): AccountDataCleanupResult {
  const users = readStoredUsers(storage);
  const remainingUsers = removeLocalUser(users, removedUserId);

  storage.setItem(USERS_KEY, JSON.stringify(remainingUsers));
  storage.removeItem(getUserDataKey(removedUserId));
  // A minimal tombstone prevents other open tabs from recreating erased data.
  storage.setItem(getUserErasureKey(removedUserId), "1");
  // Enumerate before removing: Storage indices shift after each deletion.
  const keys = Array.from({ length: storage.length ?? 0 }, (_, index) => storage.key?.(index));
  const erasedPrefixes = [getUserDataKey(removedUserId), STORAGE_KEY, LEGACY_STORAGE_KEY];
  for (const key of keys) {
    if (key && erasedPrefixes.some((prefix) => key.startsWith(prefix + ":corrupt:") || key.startsWith(prefix + ":recovery:"))) {
      storage.removeItem(key);
    }
  }
  storage.removeItem(STORAGE_KEY);
  storage.removeItem(LEGACY_STORAGE_KEY);
  if (options.clearServerSession !== false) storage.removeItem(SERVER_SESSION_STORAGE_KEY);

  const activeId = storage.getItem(ACTIVE_USER_KEY);
  const nextActive = remainingUsers.find((user) => user.id === activeId) ?? remainingUsers[0] ?? null;
  if (nextActive) {
    storage.setItem(ACTIVE_USER_KEY, nextActive.id);
  } else {
    storage.removeItem(ACTIVE_USER_KEY);
  }

  return { remainingUsers, activeUserId: nextActive?.id ?? null };
}

function readStoredUsers(storage: StringStorage): AppUser[] {
  const stored = storage.getItem(USERS_KEY);
  if (!stored) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is AppUser =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as AppUser).id === "string" &&
        typeof (entry as AppUser).name === "string"
    );
  } catch {
    return [];
  }
}
