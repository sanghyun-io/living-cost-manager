import { describe, expect, it, vi } from 'vitest';
import { createTourApi, createTourController, createTourStorage, mergeTourStatus, parseTourResponse, tourKey, tourNeedsManagementOpen, type TourStatus } from '../app/lib/productTour';

const a = { id: 'a', token: 'synthetic-a', baseUrl: 'https://synthetic.invalid/v1' };
const b = { ...a, id: 'b', token: 'synthetic-b' };
const response = (status: TourStatus = 'unseen') => ({ version: 1 as const, status, updatedAt: status === 'unseen' ? null : '2026-10-10T00:00:00.000Z' });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  const data = new Map<string, string>();
  const store = createTourStorage(() => ({ getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } }));
  const api = { verify: vi.fn<ReturnType<typeof createTourApi>['verify']>(async () => {}), get: vi.fn<ReturnType<typeof createTourApi>['get']>(async () => response()), put: vi.fn<ReturnType<typeof createTourApi>['put']>(async (_a, _signal, status) => response(status)) };
  const controller = createTourController(store, api, vi.fn());
  return { store, api, controller, data };
}
describe('isolated product tour contract', () => {
  it.each([response(), response('completed'), response('skipped')])('validates ISO timestamp or null %j', value => expect(parseTourResponse(value)).toEqual(value));
  it.each([null, {}, { ...response(), version: 2 }, { ...response(), status: 'bad' }, { ...response(), updatedAt: 12 }, { ...response(), updatedAt: '2026-10-10' }, { ...response(), updatedAt: 'not-a-date' }])('fails closed on malformed %j', value => expect(() => parseTourResponse(value)).toThrow());
  it('sends only the strict tour request; validates actual identity before any tour state', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => new Response(JSON.stringify(String(url).endsWith('/me') ? { user: { id: 'a' } } : response(init?.method === 'PUT' ? 'completed' : 'unseen')), { status: 200 }));
    const api = createTourApi(fetcher); const abort = new AbortController();
    await api.verify(a, abort.signal); await api.get(a, abort.signal); await api.put(a, abort.signal, 'completed');
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([a.baseUrl + '/me', a.baseUrl + '/onboarding/product-tour', a.baseUrl + '/onboarding/product-tour']);
    expect(fetcher.mock.calls[2][1]?.body).toBe('{"version":1,"status":"completed"}');
    expect(fetcher.mock.calls.every(call => call[1]?.signal === abort.signal)).toBe(true);
    await expect(api.verify(b, abort.signal)).rejects.toThrow();
  });
  it.each([404, 500, 401])('does not interpret HTTP %d as unseen', async status => {
    const api = createTourApi(async () => new Response('{}', { status }));
    await expect(api.get(a, new AbortController().signal)).rejects.toThrow();
  });
  it('storage exceptions/corrupt values fall back safely and separate scopes', () => {
    const store = createTourStorage(() => { throw Error('blocked'); });
    store.write('local:guest', { version: 1, status: 'skipped', pending: false });
    expect(store.read('local:guest').status).toBe('skipped'); expect(store.read('account:a').status).toBe('unseen');
    expect(tourKey('account:a')).not.toBe(tourKey('local:a'));
    expect(createTourStorage(() => ({ getItem: () => '{bad', setItem() {} })).read('a').status).toBe('unseen');
  });
  it('does not force-start or write GET; invites only once per page/scope', async () => {
    const f = fixture(); await f.controller.enter('account:a', a);
    expect(f.controller.invitation).toBe(true); expect(f.api.put).not.toHaveBeenCalled();
    f.controller.dismissInvitation(); await f.controller.enter('account:a', a);
    expect(f.controller.invitation).toBe(false);
    await f.controller.enter('account:b', b); expect(f.controller.invitation).toBe(true);
  });
  it('guest skip → auth boot → login suppresses repeat invitation without copying or PUT', async () => {
    const f = fixture(); await f.controller.enter('local:guest', null); f.controller.finish('skipped');
    await f.controller.enter('', null); await f.controller.enter('account:a', a);
    expect(f.controller.invitation).toBe(false); expect(f.store.read('account:a').status).toBe('unseen'); expect(f.api.put).not.toHaveBeenCalled();
    await f.controller.enter('account:b', b); expect(f.controller.invitation).toBe(true);
  });
  it('completed replay close cannot regress or issue a redundant PUT', async () => {
    const f = fixture(); f.api.get.mockResolvedValue(response('completed'));
    await f.controller.enter('account:a', a); f.controller.finish('skipped'); await settle();
    expect(f.controller.status).toBe('completed'); expect(f.api.put).not.toHaveBeenCalled();
    expect(mergeTourStatus('completed', 'skipped')).toBe('completed');
  });
  it('server terminal state wins unseen local and prevents cross-browser invitation', async () => {
    const f = fixture(); f.api.get.mockResolvedValue(response('skipped')); await f.controller.enter('account:a', a);
    expect(f.controller.invitation).toBe(false); expect(f.controller.status).toBe('skipped'); expect(f.api.put).not.toHaveBeenCalled();
  });
  it('failure/404/format error defers auto invitation but manual finish is safely queued', async () => {
    const f = fixture(); f.api.get.mockRejectedValue(Error('404')); await f.controller.enter('account:a', a);
    expect(f.controller.invitation).toBe(false); f.controller.finish('completed'); await settle();
    expect(f.api.put).not.toHaveBeenCalled(); expect(f.store.read('account:a').pending).toBe(true);
    f.api.get.mockResolvedValue(response()); await f.controller.enter('account:a', a); await settle();
    expect(f.api.put).toHaveBeenCalledOnce(); expect(f.store.read('account:a').pending).toBe(false);
  });
  it('failed PUT never flushes to another account; resumes on same-account verified GET', async () => {
    const f = fixture(); f.api.put.mockRejectedValueOnce(Error('offline'));
    await f.controller.enter('account:a', a); f.controller.finish('completed'); await settle();
    await f.controller.enter('account:b', b); await settle(); expect(f.api.put).toHaveBeenCalledOnce();
    await f.controller.enter('account:a', a); await settle(); expect(f.api.put).toHaveBeenCalledTimes(2);
    expect(f.api.put.mock.calls.every(call => call[0].id === 'a')).toBe(true);
  });
  it('account without API stays manual-only and queues its own finish', async () => {
    const f = fixture(); await f.controller.enter('account:a', null);
    expect(f.controller.invitation).toBe(false); f.controller.finish('completed');
    expect(f.store.read('account:a').pending).toBe(true); expect(f.api.put).not.toHaveBeenCalled();
    await f.controller.enter('account:a', a); await settle(); expect(f.api.put).toHaveBeenCalledOnce();
  });
  it('sample/guest/mismatched scope can never send an account PUT even if given a session', async () => {
    const f = fixture(); await f.controller.enter('sample:guest', a); f.controller.finish('completed');
    await f.controller.enter('local:guest', a); f.controller.finish('skipped');
    await f.controller.enter('account:b', a); f.controller.finish('completed'); await settle();
    expect(f.api.verify).not.toHaveBeenCalled(); expect(f.api.put).not.toHaveBeenCalled();
  });
  it('late GET after logout/account/ledger/sample transition is aborted and discarded', async () => {
    const f = fixture(); let release!: (value: ReturnType<typeof response>) => void;
    f.api.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const enter = f.controller.enter('account:a', a); await settle();
    const oldSignal = f.api.get.mock.calls[0][1];
    await f.controller.enter('sample:guest', null); release(response('completed')); await enter;
    expect(oldSignal.aborted).toBe(true); expect(f.store.read('account:a').status).toBe('unseen'); expect(f.controller.status).toBe('unseen');
    f.controller.finish('completed'); expect(f.api.put).not.toHaveBeenCalled();
  });
  it.each(['', 'account:b', 'account:a'])('discards stale GET on transition to %s', async nextScope => {
    const f = fixture(); let release!: (value: ReturnType<typeof response>) => void;
    f.api.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const enter = f.controller.enter('account:a', a); await settle();
    await f.controller.enter(nextScope, nextScope ? nextScope === 'account:b' ? b : a : null);
    release(response('completed')); await enter;
    expect(f.store.read('account:a').status).toBe('unseen'); expect(f.api.put).not.toHaveBeenCalled();
  });
  it('server completion cancels a queued skip without PUT', async () => {
    const f = fixture(); f.store.write('account:a', { version: 1, status: 'skipped', pending: true });
    f.api.get.mockResolvedValue(response('completed')); await f.controller.enter('account:a', a); await settle();
    expect(f.store.read('account:a')).toEqual({ version: 1, status: 'completed', pending: false }); expect(f.api.put).not.toHaveBeenCalled();
  });
  it('late PUT after another account cannot clear outgoing pending status', async () => {
    const f = fixture(); let release!: (value: ReturnType<typeof response>) => void;
    f.api.put.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await f.controller.enter('account:a', a); f.controller.finish('completed'); await settle();
    await f.controller.enter('account:b', b); release(response('completed')); await settle();
    expect(f.store.read('account:a').pending).toBe(true); expect(f.store.read('account:b').status).toBe('unseen');
  });
  it('local completed survives late skip response and queues completed after inflight skip', async () => {
    const f = fixture(); let release!: (value: ReturnType<typeof response>) => void;
    f.api.put.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await f.controller.enter('account:a', a); f.controller.finish('skipped'); f.controller.finish('completed');
    release(response('skipped')); await settle();
    expect(f.controller.status).toBe('completed'); expect(f.api.put.mock.calls.map(call => call[2])).toEqual(['skipped', 'completed']);
  });
});

describe('management-opening tour steps', () => {
  it('only the add and due steps require the collapsed management panel', () => {
    expect([0, 1].map(tourNeedsManagementOpen)).toEqual([true, true]);
    for (const step of [null, 2, 3, 4, -1]) expect(tourNeedsManagementOpen(step)).toBe(false);
  });
});
