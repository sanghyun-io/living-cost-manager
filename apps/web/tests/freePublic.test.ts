import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { FREE_PUBLIC_RELEASE, CROSS_LEDGER_AGGREGATION_AVAILABLE, canCreateFirstOwnedLedger } from '../app/lib/publicRelease';
import { faqs, guides } from '../app/guide/content';

const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock('react', () => ({
  useRef(initial: unknown) { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i]; },
  useState(initial: unknown) { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = initial; return [hooks.slots[i], (action: any) => { const next = typeof action === 'function' ? action(hooks.slots[i]) : action; if (!Object.is(next, hooks.slots[i])) { hooks.slots[i] = next; hooks.dirty = true; } }]; },
  useEffect(effect: () => unknown, deps: unknown[]) { const i = hooks.cursor++, previous = hooks.slots[i]; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) { hooks.slots[i] = deps; hooks.effects.push(effect); } }
}));
import { useLedgers } from '../app/lib/useLedgers';
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.dirty = false;
  vi.stubGlobal('window', { localStorage: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());
function setup(allowed: boolean, checked = true) {
  const auth: any = { serverSession: { token: 'synthetic', user: { id: 'fixture', emailVerified: true }, workspace: null },
    serverApi: { createWorkspace: vi.fn(async () => ({})), aggregateWorkspaces: vi.fn() }, matchesServerScope: () => true };
  const sync: any = { canCreateFirstOwnedLedger: allowed, canCreateFirstOwnedLedgerNow: () => sync.canCreateFirstOwnedLedger, isWorkspaceListChecked: checked, loadServerWorkspaces: vi.fn(async () => ({ status: 'applied', isCurrent: () => true, workspaces: [] })) };
  const render = () => { let result!: ReturnType<typeof useLedgers>; do { hooks.dirty = false; hooks.cursor = 0; result = useLedgers(auth, sync); for (const effect of hooks.effects.splice(0)) effect(); } while (hooks.dirty); return result; };
  return { auth, sync, render };
}
test('free scope counts ownership, not sharing, and fails closed without a current list', () => {
  expect(FREE_PUBLIC_RELEASE).toBe(true); expect(CROSS_LEDGER_AGGREGATION_AVAILABLE).toBe(false);
  expect(canCreateFirstOwnedLedger([], false)).toBe(false);
  expect(canCreateFirstOwnedLedger([], true)).toBe(true);
  expect(canCreateFirstOwnedLedger([{ role: 'viewer' }, { role: 'editor' }] as any, true)).toBe(true);
  expect(canCreateFirstOwnedLedger([{ role: 'owner' }, { role: 'viewer' }] as any, true)).toBe(false);
  expect(canCreateFirstOwnedLedger([{ role: 'owner' }, { role: 'owner' }] as any, true)).toBe(false);
});
test.each([true, false])('unavailable creation does not send POST or mark uncertain (checked=%s)', async checked => {
  const f = setup(false, checked); expect(await f.render().create('Blocked')).toBe(false);
  expect(f.auth.serverApi.createWorkspace).not.toHaveBeenCalled(); expect(window.localStorage.setItem).not.toHaveBeenCalled();
  expect(f.render().status).toContain(checked ? '현재 무료판' : '목록을 확인');
});
test('first ledger creation remains available with existing mutation safety', async () => {
  const f = setup(true); expect(await f.render().create('First')).toBe(true);
  expect(f.auth.serverApi.createWorkspace).toHaveBeenCalledTimes(1);
  expect(f.render().uncertain).toBe(false);
});
test('an old handler rechecks the current proof after an async boundary', async () => {
  const f = setup(true), previous = f.render(); f.sync.canCreateFirstOwnedLedger = false;
  expect(await previous.create('Stale')).toBe(false); expect(f.auth.serverApi.createWorkspace).not.toHaveBeenCalled();
});
test('aggregate callbacks cannot activate or request the hidden feature', async () => {
  const f = setup(false); f.render().select(['one', 'two']); f.render().setAggregateMode(true);
  await f.render().loadAggregate(); expect(f.render().aggregateMode).toBe(false);
  expect(f.auth.serverApi.aggregateWorkspaces).not.toHaveBeenCalled();
});
test('paid route is archived, never routed/imported by public guide or settings', () => {
  expect(existsSync('app/subscription/page.tsx')).toBe(false);
  expect(existsSync('app/features/service-subscription/route-entry.tsx')).toBe(true);
  for (const path of ['app/guide/page.tsx', 'app/components/modals/DataModal.tsx']) {
    expect(readFileSync(path, 'utf8')).not.toMatch(/subscription\/|PricingPreview|servicePricingCopy/);
  }
  expect(JSON.stringify({ guides, faqs })).not.toMatch(/990|9,900|가격안|유료 요금|선택한 가계부 합산 조회|합산 보기/);
});
