import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock('react', () => ({
  useRef(initial: unknown) { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i]; },
  useState(initial: unknown) { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = initial; return [hooks.slots[i], (action: any) => { const next = typeof action === 'function' ? action(hooks.slots[i]) : action; if (!Object.is(next, hooks.slots[i])) { hooks.slots[i] = next; hooks.dirty = true; } }]; },
  useEffect(effect: () => unknown, deps: unknown[]) { const i = hooks.cursor++, previous = hooks.slots[i]; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) { hooks.slots[i] = deps; hooks.effects.push(effect); } }
}));
import { ledgerCreationKey, useLedgers } from '../app/lib/useLedgers';
let values: Map<string, string>;
beforeEach(() => { hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.dirty = false; values = new Map(); vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } }); });
afterEach(() => vi.unstubAllGlobals());
function setup() {
  let fail!: (error: Error) => void;
  const auth: any = { serverSession: { token: 'synthetic', user: { id: 'a', emailVerified: true }, workspace: { id: 'one', role: 'owner' } },
    serverApi: { createWorkspace: vi.fn(() => new Promise((_resolve, reject) => { fail = reject; })) },
    matchesServerScope: (account: string, workspace: string) => auth.serverSession?.user.id === account && auth.serverSession?.workspace?.id === workspace };
  const sync: any = { loadServerWorkspaces: vi.fn(async () => [{ id: 'one', name: 'Existing', role: 'owner' }]) };
  function render() { let result!: ReturnType<typeof useLedgers>; let count = 0; do { if (++count > 30) throw Error('did not settle'); hooks.dirty = false; hooks.cursor = 0; result = useLedgers(auth, sync); for (const effect of hooks.effects.splice(0)) effect(); } while (hooks.dirty); return result; }
  return { auth, sync, render, fail: () => fail(new Error('synthetic network failure')) };
}
it('aggregate toggles and workspace epochs never clear a held account mutation or its stale uncertainty', async () => {
  const f = setup(); const request = f.render().create('Attempt');
  expect(f.render().mutationPending).toBe(true); f.render().setAggregateMode(true);
  expect(f.render().busy).toBe(true);
  f.auth.serverSession.workspace.id = 'two'; expect(f.render().mutationPending).toBe(true);
  f.fail(); await request;
  expect(f.render().uncertain).toBe(true); expect(f.render().mutationPending).toBe(false);
  await f.render().create('Duplicate'); expect(f.auth.serverApi.createWorkspace).toHaveBeenCalledTimes(1);
  await f.render().refresh(); expect(f.render().uncertain).toBe(true); expect(f.render().reconciliationReady).toBe(true);
  f.render().acknowledgeReconciliation(); expect(f.render().uncertain).toBe(false);
});
it('late A outcomes do not leak into B and remain blocked when A returns or the hook reloads', async () => {
  const f = setup(); const request = f.render().create('Attempt-A');
  f.auth.serverSession = { ...f.auth.serverSession, user: { id: 'b', emailVerified: true } };
  expect(f.render().mutationPending).toBe(false); f.fail(); await request;
  expect(f.render().uncertain).toBe(false); expect(f.render().status).not.toContain('Attempt-A');
  f.auth.serverSession.user.id = 'a'; expect(f.render().uncertain).toBe(true);
  expect(values.get(ledgerCreationKey('a'))).toBe('Attempt-A');
  hooks.slots = []; expect(f.render().uncertain).toBe(true);
  f.render().acknowledgeReconciliation(); expect(f.render().uncertain).toBe(true); // no actual list refresh yet
});
it('storage failure before sending refuses POST instead of losing durable uncertainty tracking', async () => {
  const f = setup(); (window.localStorage.setItem as any) = () => { throw Error('quota'); };
  expect(await f.render().create('Never sent')).toBe(false);
  expect(f.auth.serverApi.createWorkspace).not.toHaveBeenCalled(); expect(f.render().status).toContain('요청을 보내지 않았습니다');
});
