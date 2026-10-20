// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../app/components/ThemeProvider';
import { AppearanceSettings } from '../app/components/AppearanceSettings';
import { useLocalUsers } from '../app/lib/useLocalUsers';
import { useUiTheme } from '../app/lib/useUiTheme';
import { createThemeApi } from '../app/lib/uiTheme';
import { createUser, getUserDataKey, getUserErasureKey, type AppUser } from '../app/lib/users';
import { ACTIVE_USER_KEY, USERS_KEY } from '../app/lib/storage';
import { SERVER_SESSION_STORAGE_KEY, type ServerSession } from '../app/lib/serverApi';
import { emptyBudgetSnapshot } from '../app/lib/seedData';

// No auth server, financial endpoint, browser profile or real account is used.
const base = 'http://theme.synthetic.invalid';
const session = (id: string) => ({ token: `test-only-${id}`, refreshToken: `refresh-${id}`,
  user: { id, name: 'Same display name', email: `${id}@example.invalid` },
  workspace: { id: 'same-workspace' } }) as ServerSession;
const profile = (id: string, uiTheme: AppUser['uiTheme'] = 'jade'): AppUser => ({ id: `server:${id}`, serverUserId: id, name: 'Same display name', uiTheme });
const registry = (): AppUser[] => JSON.parse(localStorage.getItem(USERS_KEY)!);
const stored = (id: string) => registry().find(user => user.serverUserId === id)!;
const choose = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const settle = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };

type Request = { url: string; init: RequestInit; resolve: (response: Response) => void };
function transport() {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => new Promise<Response>(resolve => requests.push({ url, init, resolve }))));
  const get = (id: string, method = 'GET', index = 0) => requests.filter(r => (r.init.method ?? 'GET') === method && (r.init.headers as Record<string, string>).Authorization === `Bearer test-only-${id}`)[index];
  const reply = async (request: Request, body: unknown, status = 200) => {
    expect(request).toBeDefined();
    await act(async () => { request.resolve(new Response(JSON.stringify(body), { status })); });
    await settle();
  };
  return { requests, get, reply };
}
function seed(users: AppUser[] = [profile('A'), profile('B', 'aqua')], active = users[0].id, account: ServerSession | null = session('A')) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users)); localStorage.setItem(ACTIVE_USER_KEY, active);
  if (account) localStorage.setItem(SERVER_SESSION_STORAGE_KEY, JSON.stringify(account));
  for (const user of users) localStorage.setItem(getUserDataKey(user.id), JSON.stringify(emptyBudgetSnapshot));
}
function App() {
  const [account, setAccount] = useState<ServerSession | null>(null);
  const checked = useRef(true);
  const auth = { serverSession: account, serverApi: null, serverRestoreCheckedRef: checked, applyBootSession: setAccount };
  const ui = { setImportMessage() {}, closeDataAndManagementModals() {}, setIsDeleteMode() {}, setSelectedDeleteIds() {} };
  const users = useLocalUsers({ auth, ui, getBudget: () => emptyBudgetSnapshot } as never);
  const appearance = useUiTheme(users, account, base);
  return <><AppearanceSettings {...appearance} /><output aria-label="memory-profile">{JSON.stringify(users.currentUser)}</output>
    {['A', 'B'].map(id => <button key={id} onClick={() => { setAccount(session(id)); users.handleLogin('Same display name', 'server', session(id).user); }}>Login {id}</button>)}
    <button onClick={() => { setAccount(null); users.handleLogout(); }}>Logout account</button></>;
}
function mount() { return render(<ThemeProvider><App /></ThemeProvider>); }
const memory = () => JSON.parse(screen.getByLabelText('memory-profile').textContent!);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); delete document.documentElement.dataset.lcmTheme; });

describe('independent real-hook theme request ordering and private profile storage', () => {
  it('deferred pre-choice GET cannot replace violet; actual API saves only theme and preserves financial bytes', async () => {
    seed(); const financial = localStorage.getItem(getUserDataKey('server:A'));
    const http = transport(); mount(); await settle();
    const old = http.get('A'); choose('바이올렛');
    await http.reply(old, { user: { id: 'A', uiTheme: 'jade' } });
    expect(memory().uiTheme).toBe('violet');
    await http.reply(http.get('A', 'GET', 1), { user: { id: 'A', uiTheme: 'jade', privateCoach: 'synthetic-private' } });
    const write = http.get('A', 'PUT');
    expect(write.url).toBe(base + '/me/theme'); expect(JSON.parse(write.init.body as string)).toEqual({ uiTheme: 'violet' });
    await http.reply(write, { uiTheme: 'violet' });
    expect(stored('A')).toMatchObject({ uiTheme: 'violet', uiThemePending: false, name: 'Same display name' });
    expect(localStorage.getItem(getUserDataKey('server:A'))).toBe(financial);
    expect(localStorage.getItem(USERS_KEY)).not.toContain('privateCoach');
    expect(screen.getByText('계정에 저장됨')).toBeTruthy(); expect(http.requests).toHaveLength(3);
  });

  it.each([200, 500])('coalesces rapid violet→aqua through a stale %s response with captured credentials', async status => {
    seed(); const http = transport(); mount(); await settle(); await http.reply(http.get('A'), { user: { id: 'A', uiTheme: 'jade' } });
    choose('바이올렛'); const first = http.get('A', 'PUT'); choose('아쿠아');
    expect(http.requests.filter(r => r.init.method === 'PUT')).toHaveLength(1);
    await http.reply(first, status === 200 ? { uiTheme: 'violet' } : { error: 'synthetic failure' }, status);
    expect(memory().uiTheme).toBe('aqua'); expect(stored('A').uiThemePending).toBe(true);
    const last = http.get('A', 'PUT', 1); expect(JSON.parse(last.init.body as string)).toEqual({ uiTheme: 'aqua' });
    await http.reply(last, { uiTheme: 'aqua' });
    expect(stored('A').uiThemePending).toBe(false); expect(http.requests).toHaveLength(3);
  });

  it('A pending PUT cannot repaint B, change B storage or send A preference with B token in a shared workspace', async () => {
    seed(); const http = transport(); mount(); await settle(); await http.reply(http.get('A'), { user: { id: 'A', uiTheme: 'jade' } });
    choose('바이올렛'); const aWrite = http.get('A', 'PUT'); choose('Login B'); await settle();
    expect((aWrite.init.signal as AbortSignal).aborted).toBe(true);
    await http.reply(http.get('B'), { user: { id: 'B', uiTheme: 'tangerine' } });
    await http.reply(aWrite, { uiTheme: 'violet' });
    expect(document.documentElement.dataset.lcmTheme).toBe('tangerine'); expect(memory().serverUserId).toBe('B');
    expect(stored('A')).toMatchObject({ uiTheme: 'violet', uiThemePending: true }); expect(stored('B').uiTheme).toBe('tangerine');
    expect(http.get('B', 'PUT')).toBeUndefined();
  });

  it('logout aborts credentials and guest reload stays independent of delayed account responses', async () => {
    seed(); const http = transport(); const view = mount(); await settle(); const old = http.get('A');
    choose('Logout account'); await settle(); expect(old.init.signal?.aborted).toBe(true);
    expect(document.documentElement.dataset.lcmTheme).toBe('jade'); const guest = memory().id; expect(guest).toMatch(/^guest:/);
    choose('라즈베리'); await http.reply(old, { user: { id: 'A', uiTheme: 'violet' } });
    expect(memory()).toMatchObject({ id: guest, uiTheme: 'raspberry' });
    // The real auth hook removes its session on logout; our minimal auth boundary mirrors that storage operation.
    localStorage.removeItem(SERVER_SESSION_STORAGE_KEY); view.unmount(); mount(); await settle();
    expect(memory()).toMatchObject({ id: guest, uiTheme: 'raspberry' }); expect(http.requests).toHaveLength(1);
  });

  it('401 verification prevents writes and reconnect preserves pending local intent instead of importing remote jade', async () => {
    seed([ { ...profile('A', 'aqua'), uiThemePending: true } ]); const http = transport(); mount(); await settle();
    await http.reply(http.get('A'), { error: 'unauthorized' }, 401);
    expect(screen.getByText('현재 선택 유지 · 계정 저장 확인 실패')).toBeTruthy(); expect(http.get('A', 'PUT')).toBeUndefined();
    fireEvent(window, new Event('online')); await settle();
    await http.reply(http.get('A', 'GET', 1), { user: { id: 'A', uiTheme: 'jade' } });
    expect(memory().uiTheme).toBe('aqua');
    await http.reply(http.get('A', 'PUT'), { uiTheme: 'aqua' });
    expect(stored('A')).toMatchObject({ uiTheme: 'aqua', uiThemePending: false });
  });

  it('legacy /me defaults jade but older unsupported theme endpoint never claims cloud persistence', async () => {
    seed([profile('A', 'violet')]); const http = transport(); mount(); await settle();
    await http.reply(http.get('A'), { user: { id: 'A', name: 'Legacy DTO' } });
    expect(memory().uiTheme).toBe('jade'); choose('아쿠아');
    await http.reply(http.get('A', 'PUT'), { error: 'not found' }, 404);
    expect(stored('A')).toMatchObject({ uiTheme: 'aqua', uiThemePending: true });
    expect(screen.queryByText('계정에 저장됨')).toBeNull(); expect(screen.getByRole('button', { name: '계정 저장 다시 확인' })).toBeTruthy();
  });

  it('blocked registry writes retain actual AppUser memory and report failed cloud save without false durability', async () => {
    seed(); const http = transport(); mount(); await settle(); await http.reply(http.get('A'), { user: { id: 'A', uiTheme: 'jade' } });
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) { if (key === USERS_KEY) throw new DOMException('Synthetic quota', 'QuotaExceededError'); original.call(this, key, value); });
    choose('바이올렛'); await http.reply(http.get('A', 'PUT'), { error: 'unavailable' }, 503);
    expect(memory()).toMatchObject({ uiTheme: 'violet', uiThemePending: true }); expect(stored('A').uiTheme).toBe('jade');
    expect(screen.getByText('현재 선택 유지 · 계정 저장 확인 실패')).toBeTruthy(); expect(screen.queryByText('계정에 저장됨')).toBeNull();
  });

  it('erasure tombstone blocks an already dispatched save from resurrecting the removed registry profile', async () => {
    seed(); const http = transport(); mount(); await settle(); await http.reply(http.get('A'), { user: { id: 'A', uiTheme: 'jade' } }); choose('바이올렛');
    localStorage.setItem(getUserErasureKey('server:A'), 'synthetic-erasure');
    localStorage.setItem(USERS_KEY, JSON.stringify(registry().filter(user => user.serverUserId !== 'A')));
    await http.reply(http.get('A', 'PUT'), { uiTheme: 'violet' }); choose('아쿠아');
    expect(registry().some(user => user.serverUserId === 'A')).toBe(false);
    expect(memory().uiThemePending).toBe(true); expect(http.requests).toHaveLength(2);
  });

  it('active legacy local ID is server-bound, but a same-name unrelated local profile is never overwritten', async () => {
    const legacy = { ...createUser('Same display name'), uiTheme: 'violet' as const, templateReturnId: 'original-private-local' };
    seed([legacy, profile('B', 'aqua')], legacy.id); const http = transport(); mount(); await settle();
    expect(memory()).toMatchObject({ id: legacy.id, serverUserId: 'A', templateReturnId: 'original-private-local' });
    await http.reply(http.get('A'), { user: { id: 'B', uiTheme: 'tangerine' } }); choose('아쿠아'); await settle();
    await http.reply(http.get('A', 'GET', 1), { user: { id: 'B', uiTheme: 'tangerine' } });
    expect(http.get('A', 'PUT')).toBeUndefined(); expect(stored('B').uiTheme).toBe('aqua');
    expect(registry().find(user => user.id === legacy.id)).toMatchObject({ serverUserId: 'A', templateReturnId: 'original-private-local', uiTheme: 'aqua' });
  });

  it('corrupt local enum normalizes to jade; all five accents preserve brightness without a render/request loop', async () => {
    const local = { id: 'local-fixture', name: 'Synthetic local', uiTheme: 'invalid-enum' } as unknown as AppUser;
    seed([local], local.id, null); const http = transport(); mount(); await settle(); expect(document.documentElement.dataset.lcmTheme).toBe('jade');
    for (const dark of [false, true]) {
      if (dark) choose('어둡게 보기');
      for (const [label, theme] of [['제이드', 'jade'], ['아쿠아', 'aqua'], ['바이올렛', 'violet'], ['라즈베리', 'raspberry'], ['탠저린', 'tangerine']]) {
        choose(label); await settle(); expect(memory().uiTheme).toBe(theme); expect(registry()[0].uiTheme).toBe(theme);
        expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('true');
        expect(document.documentElement.dataset.mantineColorScheme).toBe(dark ? 'dark' : 'light');
      }
    }
    expect(http.requests).toHaveLength(0);
  });
});

describe('independent HTTP boundary errors (real createThemeApi)', () => {
  it.each([null, 'blue', {}, 7])('rejects malformed server theme %j instead of silently importing it', async uiTheme => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ user: { id: 'A', uiTheme } })));
    await expect(createThemeApi(fetcher).read({ id: 'A', token: 'synthetic', baseUrl: base }, new AbortController().signal)).rejects.toThrow('Invalid theme response');
  });
  it('rejects a successful HTTP save with an acknowledgement for a different theme', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ uiTheme: 'jade' })));
    await expect(createThemeApi(fetcher).write({ id: 'A', token: 'synthetic', baseUrl: base }, 'aqua', new AbortController().signal)).rejects.toThrow('Theme save unavailable');
  });
});
