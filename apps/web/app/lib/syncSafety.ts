import type { LocalBudgetSnapshot } from "./snapshot";

export interface SyncSafety {
  scope: string;
  baseline: string | null;
  version: number | null;
  blocked: boolean;
  enabled: boolean;
  busy: boolean;
}

export function createSyncSafety(scope: string): SyncSafety {
  return { scope, baseline: null, version: null, blocked: false, enabled: false, busy: false };
}

export function syncScope(localUserId: string | null, ready: boolean, userId?: string, workspaceId?: string) {
  return localUserId && ready && userId && workspaceId ? JSON.stringify([localUserId, userId, workspaceId]) : "";
}

// Include every persisted field (including end-of-month and future additions).
export function syncSnapshotKey(snapshot: LocalBudgetSnapshot): string {
  return JSON.stringify(snapshot);
}

export function canAutoSync(state: SyncSafety, key: string): boolean {
  return !!state.scope && state.enabled && !state.blocked && !state.busy &&
    state.version !== null && state.baseline !== null && state.baseline !== key;
}

export function canReplaceLocal(start: SyncSafety, current: SyncSafety, before: string, now: string): boolean {
  return !!start.scope && start === current && before === now;
}

export function blockSync(state: SyncSafety): void {
  state.blocked = true;
  state.enabled = false;
}

export function establishSyncBaseline(state: SyncSafety, key: string, version: number): void {
  state.baseline = key;
  state.version = version;
  state.blocked = false;
}
