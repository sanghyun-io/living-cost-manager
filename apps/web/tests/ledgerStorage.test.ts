import { describe, expect, it } from 'vitest';
import { ledgerProfileId, migrateLedgerCache } from '../app/lib/ledgerStorage';
import { getUserDataKey, getUserErasureKey } from '../app/lib/users';
import { cleanupLocalAccountData } from '../app/lib/account';
import { USERS_KEY } from '../app/lib/storage';
import { createSyncSafety, canReplaceLocal, syncScope, establishSyncBaseline, canAutoSync } from '../app/lib/syncSafety';
import { summarizeWorkspaceBudget, sumWorkspaceBudgets } from '@living-cost-manager/shared';
import { buildBudgetSummary, type FixedCost } from '../app/lib/budget';

function storage() {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe('account + ledger isolation', () => {
  it('preserves unsynced legacy data only in the original active ledger and leaves the source intact', () => {
    const store = storage(), original = JSON.stringify({ unsynced: 'edits', monthlyIncome: 123 });
    store.setItem(getUserDataKey('server:a'), original);
    migrateLedgerCache(store, 'a', 'original', 'server:a');
    migrateLedgerCache(store, 'a', 'second', 'server:a');
    expect(store.getItem(getUserDataKey(ledgerProfileId('a', 'original')))).toBe(original);
    expect(store.getItem(getUserDataKey(ledgerProfileId('a', 'second')))).toBeNull();
    expect(store.getItem(getUserDataKey('server:a'))).toBe(original);
  });
  it('does not overwrite a destination conflict or migrate that source to another account', () => {
    const store = storage(); store.setItem(getUserDataKey('server:a'), 'unsynced');
    const key = getUserDataKey(ledgerProfileId('a', 'original')); store.setItem(key, 'other edits');
    migrateLedgerCache(store, 'a', 'original', 'server:a');
    expect(store.getItem(key)).toBe('other edits'); expect(store.getItem(getUserDataKey('server:a'))).toBe('unsynced');
    expect(ledgerProfileId('a', 'x')).not.toBe(ledgerProfileId('b', 'x'));
    expect(ledgerProfileId('a:b', 'x')).not.toBe(ledgerProfileId('a', 'b:x'));
  });
  it('erases all ledger caches and recoveries for the account, never guest or other accounts', () => {
    const store = storage(); store.setItem(USERS_KEY, JSON.stringify([{ id: 'old-profile', name: 'A', serverUserId: 'a' }, { id: 'guest', name: 'Guest' }]));
    const keys = [getUserDataKey(ledgerProfileId('a', 'one')), getUserDataKey(ledgerProfileId('a', 'two')) + ':recovery:1', getUserDataKey('old-profile')];
    for (const key of keys) store.setItem(key, 'private');
    const guestKey = getUserDataKey('guest'), otherKey = getUserDataKey(ledgerProfileId('aa', 'one'));
    store.setItem(guestKey, 'guest'); store.setItem(otherKey, 'other');
    cleanupLocalAccountData(store, 'old-profile');
    for (const key of keys) expect(store.getItem(key)).toBeNull();
    expect(store.getItem(guestKey)).toBe('guest'); expect(store.getItem(otherKey)).toBe('other');
    expect(store.getItem(getUserErasureKey(ledgerProfileId('a', 'one')))).toBe('1');
  });
  it('rejects late pull across workspace/account and ABA epochs; pending baseline never follows scope', () => {
    const scope = (account: string, ledger: string) => syncScope(ledgerProfileId(account, ledger), true, account, ledger);
    const old = createSyncSafety(scope('a', 'one')); establishSyncBaseline(old, 'outgoing', 1); old.enabled = true;
    for (const next of [createSyncSafety(scope('a', 'two')), createSyncSafety(scope('b', 'one')), createSyncSafety(scope('a', 'one'))]) {
      expect(canReplaceLocal(old, next, 'same', 'same')).toBe(false);
      expect(canAutoSync(next, 'offline edits')).toBe(false);
      expect(next.baseline).toBeNull();
    }
  });
});
describe('financial display contract', () => {
  const now = new Date('2026-10-06T16:00:00Z');
  const cost = { amount: 100, periodMonths: 3, billingAnchorDate: null, isEndOfMonth: false };
  it('rounds only final monthly total consistently in individual and aggregate, and keeps duplicate expenses', () => {
    const individual = summarizeWorkspaceBudget(5000, [cost, cost], now);
    const aggregate = sumWorkspaceBudgets([summarizeWorkspaceBudget(5000, [cost], now), summarizeWorkspaceBudget(5000, [cost], now)]);
    expect(Math.round(individual.monthlyNormalizedExpense)).toBe(67);
    expect(Math.round(aggregate.monthlyNormalizedExpense)).toBe(67); expect(aggregate.fixedCostCount).toBe(2);
    expect(Math.round(buildBudgetSummary([cost, cost] as FixedCost[], 5000).monthlyExpense)).toBe(67);
    expect(buildBudgetSummary([cost, cost] as FixedCost[], 5000).annualExpense).toBe(800);
  });
  it('distinguishes unknown schedules from known zero and counts unknown alongside known totals', () => {
    expect(summarizeWorkspaceBudget(0, [cost], now).thirtyDayDue).toBeNull();
    const known = { ...cost, periodMonths: 1, billingAnchorDate: '2026-10-07' };
    const mixed = summarizeWorkspaceBudget(0, [known, cost], now);
    expect(mixed.thirtyDayDue).toBe(100); expect(mixed.unknownScheduleCount).toBe(1);
    expect(summarizeWorkspaceBudget(0, [], now).thirtyDayDue).toBe(0);
  });
});
