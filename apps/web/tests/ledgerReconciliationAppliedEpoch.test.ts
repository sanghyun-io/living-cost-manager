import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Exercise both real hooks together: list application and reconciliation must
// share the sync generation, not merely account/workspace identity.
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock('react', () => ({
  useRef(initial: unknown) { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i]; },
  useState(initial: unknown) { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = initial; return [hooks.slots[i], (action: any) => { const next = typeof action === 'function' ? action(hooks.slots[i]) : action; if (!Object.is(next, hooks.slots[i])) { hooks.slots[i] = next; hooks.dirty = true; } }]; },
  useEffect(effect: () => unknown, deps: unknown[]) { const i = hooks.cursor++, previous = hooks.slots[i]; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) { hooks.slots[i] = deps; hooks.effects.push(effect); } },
  useMemo(factory: () => unknown) { hooks.cursor++; return factory(); }
}));
import { ledgerCreationKey, useLedgers } from '../app/lib/useLedgers';
import { useWorkspaceSync } from '../app/lib/useWorkspaceSync';

let storage: Map<string, string>;
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.dirty = false;
  storage = new Map([[ledgerCreationKey('a'), 'Unconfirmed creation']]);
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  } });
});
afterEach(() => vi.unstubAllGlobals());
function held<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const oldList = [{ id: 'one', name: 'Existing', role: 'owner' }];
function setup() {
  const auth: any = {
    serverSession: { token: 'synthetic', user: { id: 'a', emailVerified: true }, workspace: { id: 'one', role: 'owner' } },
    serverApi: { listWorkspaces: vi.fn(async () => oldList) },
    setIsServerBusy: vi.fn(),
    matchesServerScope: (account: string, workspace: string) => auth.serverSession?.user.id === account && auth.serverSession?.workspace?.id === workspace
  };
  const snapshot = { monthlyIncome: 0, categories: [], cards: [], fixedCosts: [] };
  const options: any = { auth, ui: {}, coach: {}, budget: { currentBudgetSnapshot: snapshot, getCurrentBudgetSnapshot: () => snapshot }, localUserId: 'server:one', isLocalDataReady: true };
  function render() {
    let sync!: ReturnType<typeof useWorkspaceSync>, ledgers!: ReturnType<typeof useLedgers>, count = 0;
    do {
      if (++count > 30) throw Error('hooks did not settle');
      hooks.dirty = false; hooks.cursor = 0;
      sync = useWorkspaceSync(options); ledgers = useLedgers(auth, sync);
      for (const effect of hooks.effects.splice(0)) effect();
    } while (hooks.dirty);
    return { sync, ledgers };
  }
  return { auth, options, render };
}
it('held refresh discarded by sample mode cannot review the unchanged old list or clear uncertainty', async () => {
  const f = setup(); await f.render().sync.loadServerWorkspaces();
  expect(f.render().sync.serverWorkspaces).toEqual(oldList);
  const response = held<any[]>(); f.auth.serverApi.listWorkspaces.mockReturnValueOnce(response.promise);
  const refresh = f.render().ledgers.refresh();
  f.options.localUserId = 'sample'; f.render(); // same account + workspace, different sync ticket
  response.resolve([]); await refresh;
  const view = f.render();
  expect(view.sync.serverWorkspaces).toEqual(oldList);
  expect(view.ledgers.reconciliationReady).toBe(false);
  expect(view.ledgers.status).not.toContain('최신 가계부 목록');
  view.ledgers.acknowledgeReconciliation();
  expect(f.render().ledgers.uncertain).toBe(true);
  expect(storage.has(ledgerCreationKey('a'))).toBe(true);
});
it('a genuine applied empty list enables explicit review, without automatically clearing the marker', async () => {
  const f = setup(); f.auth.serverApi.listWorkspaces.mockResolvedValueOnce([]);
  await f.render().ledgers.refresh();
  expect(f.render().sync.serverWorkspaces).toEqual([]);
  expect(f.render().ledgers.reconciliationReady).toBe(true);
  expect(storage.has(ledgerCreationKey('a'))).toBe(true);
  f.render().ledgers.acknowledgeReconciliation();
  expect(f.render().ledgers.uncertain).toBe(false);
  expect(storage.has(ledgerCreationKey('a'))).toBe(false);
});
it('concurrent refreshes apply and review only the newest request', async () => {
  const f = setup(), first = held<any[]>(), second = held<any[]>();
  f.auth.serverApi.listWorkspaces.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const a = f.render().ledgers.refresh(), b = f.render().ledgers.refresh();
  second.resolve([]); await b;
  expect(f.render().ledgers.reconciliationReady).toBe(true);
  first.resolve(oldList); await a;
  expect(f.render().sync.serverWorkspaces).toEqual([]);
  expect(f.render().ledgers.reconciliationReady).toBe(true);
});
it('account change prevents late review/status leakage and does not review A on return', async () => {
  const f = setup(), response = held<any[]>();
  f.auth.serverApi.listWorkspaces.mockReturnValueOnce(response.promise);
  const refresh = f.render().ledgers.refresh();
  const original = f.auth.serverSession;
  f.auth.serverSession = { ...original, user: { id: 'b', emailVerified: true } }; f.render();
  response.resolve([]); await refresh;
  expect(f.render().ledgers.status).toBe('');
  expect(f.render().ledgers.reconciliationReady).toBe(false);
  f.auth.serverSession = original;
  expect(f.render().ledgers.reconciliationReady).toBe(false);
  f.render().ledgers.acknowledgeReconciliation();
  expect(storage.has(ledgerCreationKey('a'))).toBe(true);
});
it('a rejected latest read revokes prior review and keeps the old list clearly unreviewed', async () => {
  const f = setup(); await f.render().ledgers.refresh();
  expect(f.render().ledgers.reconciliationReady).toBe(true);
  f.auth.serverApi.listWorkspaces.mockRejectedValueOnce(Error('synthetic offline'));
  await f.render().ledgers.refresh();
  expect(f.render().sync.serverWorkspaces).toEqual(oldList);
  expect(f.render().ledgers.reconciliationReady).toBe(false);
  expect(f.render().ledgers.status).toContain('이전 목록은 검토되지');
  f.render().ledgers.acknowledgeReconciliation();
  expect(storage.has(ledgerCreationKey('a'))).toBe(true);
});
it('review proof expires when mode changes after a successful read', async () => {
  const f = setup(); await f.render().ledgers.refresh();
  f.options.localUserId = 'sample';
  const view = f.render(); expect(view.ledgers.reconciliationReady).toBe(false);
  expect(view.ledgers.status).not.toContain('최신 가계부 목록');
  view.ledgers.acknowledgeReconciliation(); expect(storage.has(ledgerCreationKey('a'))).toBe(true);
});
it('list epochs also protect mode transitions when snapshot sync scope is empty', async () => {
  const f = setup(); f.auth.serverSession.workspace = null;
  f.options.isLocalDataReady = false;
  await f.render().sync.loadServerWorkspaces();
  const response = held<any[]>(); f.auth.serverApi.listWorkspaces.mockReturnValueOnce(response.promise);
  const refresh = f.render().ledgers.refresh();
  f.options.localUserId = 'sample'; f.render();
  response.resolve([]); await refresh;
  expect(f.render().sync.serverWorkspaces).toEqual(oldList);
  expect(f.render().ledgers.reconciliationReady).toBe(false);
  f.render().ledgers.acknowledgeReconciliation();
  expect(storage.has(ledgerCreationKey('a'))).toBe(true);
});
