import type { StringStorage } from './account';
import { getUserDataKey } from './users';
export function ledgerProfileId(accountId: string, workspaceId: string): string {
  return 'ledger:' + JSON.stringify([accountId, workspaceId]);
}
export function ledgerAccountId(profileId: string): string | null {
  if (!profileId.startsWith('ledger:')) return null;
  try { const pair = JSON.parse(profileId.slice(7)); return Array.isArray(pair) && typeof pair[0] === 'string' ? pair[0] : null; } catch { return null; }
}
export function recordUnselectedLedger(storage: StringStorage, accountId: string): void {
  const marker = 'living-cost-manager:ledger-migration:' + encodeURIComponent(accountId);
  if (storage.getItem(marker) === null) storage.setItem(marker, '~unselected');
}
/** Copy, never move or overwrite. Only the first active ledger inherits legacy
 * unsynced edits. Conflicts keep both copies for an explicit sync decision. */
export function migrateLedgerCache(storage: StringStorage, accountId: string, workspaceId: string, legacyProfileId: string): boolean {
  const marker = 'living-cost-manager:ledger-migration:' + encodeURIComponent(accountId);
  const original = storage.getItem(marker);
  if (original && original !== workspaceId) return false;
  if (!original) storage.setItem(marker, workspaceId);
  if (storage.getItem(marker + ':complete')) return storage.getItem(marker + ':complete') === 'conflict';
  const source = storage.getItem(getUserDataKey(legacyProfileId));
  const target = getUserDataKey(ledgerProfileId(accountId, workspaceId));
  if (source !== null && storage.getItem(target) === null) {
    storage.setItem(target, source);
    if (storage.getItem(target) !== source) throw new Error('Ledger cache migration failed');
  }
  const conflict = source !== null && storage.getItem(target) !== source;
  storage.setItem(marker + ':complete', conflict ? 'conflict' : 'copied');
  return conflict;
}
