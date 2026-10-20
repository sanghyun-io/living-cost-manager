// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../app/components/ThemeProvider';
import { AppearanceSettings } from '../app/components/AppearanceSettings';
import { createThemeController, normalizeStoredUiTheme, themeAccents } from '../app/lib/uiTheme';
import { useUiTheme } from '../app/lib/useUiTheme';
import { useLocalUsers, type LocalUsersApi } from '../app/lib/useLocalUsers';
import type { ServerSession } from '../app/lib/serverApi';
import type { AppUser } from '../app/lib/users';
import { ACTIVE_USER_KEY, USERS_KEY } from '../app/lib/storage';
import { emptyBudgetSnapshot } from '../app/lib/seedData';

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (v: T) => void, reject!: (v?: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const credentials = (id: string) => ({ id, token: 'synthetic-' + id, baseUrl: 'http://synthetic.invalid' });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe('personal theme ordering and isolation', () => {
  it('keeps all five primary labels above 4.5 and dark focus/text readable', () => {
    function luminance(hex: string) {
      const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    }
    function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
    for (const accent of Object.values(themeAccents)) {
      expect(contrast('#FFFFFF', accent.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accent.ink, accent.soft)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accent.dark, '#20242B')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accent.dark, '#303641')).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('normalizes legacy, corrupt and unknown values without touching financial records', () => {
    for (const value of [undefined, null, {}, 'blue', '<script>', 1]) expect(normalizeStoredUiTheme(value)).toBe('jade');
    expect(normalizeStoredUiTheme('aqua')).toBe('aqua');
  });
  it('does not let a delayed GET overwrite a newer local choice', async () => {
    const get = deferred<'raspberry'>(); const write = vi.fn(async () => {}); const persist = vi.fn(() => true);
    const c = createThemeController({ read: () => get.promise, write }, () => {});
    c.enter({ theme: 'jade', pending: false }, credentials('A'), persist, () => true);
    c.choose('aqua'); get.resolve('raspberry'); await tick();
    expect(c.record.theme).toBe('aqua'); expect(write).toHaveBeenLastCalledWith(credentials('A'), 'aqua', expect.any(AbortSignal));
    expect(c.status).toBe('saved');
  });
  it('serializes rapid writes and sends the latest choice last', async () => {
    const first = deferred<void>(); const write = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const c = createThemeController({ read: async () => 'jade', write }, () => {});
    c.enter({ theme: 'jade', pending: false }, credentials('A'), () => true, () => true); await tick();
    c.choose('jade'); c.choose('violet'); c.choose('aqua');
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve(); await tick();
    expect(write.mock.calls.map(args => args[1])).toEqual(['jade', 'aqua']); expect(c.record).toEqual({ theme: 'aqua', pending: false });
  });
  it('failed older saves neither roll back nor strand the latest choice', async () => {
    const first = deferred<void>(); const write = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const c = createThemeController({ read: async () => 'jade', write }, () => {});
    c.enter({ theme: 'jade', pending: false }, credentials('A'), () => true, () => true); await tick();
    c.choose('violet'); c.choose('aqua'); first.reject(); await tick();
    expect(c.record).toEqual({ theme: 'aqua', pending: false }); expect(c.status).toBe('saved');
  });
  it('drops old account responses and captures credentials at dispatch', async () => {
    const old = deferred<void>(); const write = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(undefined);
    const c = createThemeController({ read: async () => 'jade', write }, () => {});
    const a = vi.fn(() => true), b = vi.fn(() => true);
    c.enter({ theme: 'jade', pending: false }, credentials('A'), a, () => true); await tick(); c.choose('violet');
    c.enter({ theme: 'tangerine', pending: true }, credentials('B'), b, () => true); await tick();
    old.resolve(); await tick();
    expect(c.record.theme).toBe('tangerine'); expect(write.mock.calls.map(args => [args[0].token, args[1]])).toEqual([['synthetic-A', 'violet'], ['synthetic-B', 'tangerine']]);
    expect(a).toHaveBeenCalledTimes(2); // initial authoritative GET + optimistic choice only
  });
  it('keeps unsent intent through reconnect and does not claim cloud save on 401', async () => {
    const write = vi.fn().mockRejectedValue(new Error('401'));
    const c = createThemeController({ read: async () => 'raspberry', write }, () => {});
    c.enter({ theme: 'aqua', pending: true }, credentials('A'), () => true, () => true); await tick();
    expect(c.record).toEqual({ theme: 'aqua', pending: true }); expect(c.status).toBe('failed');
    write.mockResolvedValue(undefined); c.retry(); await tick(); expect(c.record.theme).toBe('aqua'); expect(c.status).toBe('saved');
  });
  it('does not resurrect erased users after an in-flight save', async () => {
    let alive = true; const pending = deferred<void>(), persist = vi.fn(() => true);
    const c = createThemeController({ read: async () => 'jade', write: () => pending.promise }, () => {});
    c.enter({ theme: 'jade', pending: false }, credentials('A'), persist, () => alive); await tick(); c.choose('aqua');
    const before = persist.mock.calls.length; alive = false; pending.resolve(); await tick(); c.choose('violet');
    expect(persist).toHaveBeenCalledTimes(before);
  });
  it('reports page-memory fallback, not durable save', () => {
    const c = createThemeController({ read: async () => 'jade', write: async () => {} }, () => {});
    c.enter({ theme: 'jade', pending: false }, null, () => false, () => true); c.choose('aqua');
    expect(c.record.theme).toBe('aqua'); expect(c.status).toBe('memory');
  });
});

function LocalApp() {
  const auth = { serverSession: null, serverApi: null, serverRestoreCheckedRef: { current: true }, applyBootSession() {} };
  const ui = { setImportMessage() {}, closeDataAndManagementModals() {}, setIsDeleteMode() {}, setSelectedDeleteIds() {} };
  const users = useLocalUsers({ auth, ui, getBudget: () => emptyBudgetSnapshot } as never);
  const appearance = useUiTheme(users, null);
  return <><output aria-label="profile">{users.currentUser?.id}</output><AppearanceSettings {...appearance} /><button onClick={() => users.handleLogin('Alice')}>Alice</button><button onClick={() => users.handleLogin('Bob')}>Bob</button><button onClick={() => users.handleLogout()}>Logout</button></>;
}
describe('mounted React personal appearance', () => {
  it('rejects mismatched /me identity before writing and leaves personal intent local', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 'not-A', uiTheme: 'tangerine' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    function AccountApp() {
      const [currentUser, setUser] = useState<AppUser>({ id: 'server:A', serverUserId: 'A', name: 'Synthetic A', uiTheme: 'jade' });
      const users = { currentUser, updateTheme: (id: string, uiTheme: AppUser['uiTheme'], uiThemePending: boolean) => { setUser(user => user.id === id ? { ...user, uiTheme, uiThemePending } : user); return true; } } as LocalUsersApi;
      const session = { token: 'synthetic-A', user: { id: 'A' } } as ServerSession;
      const appearance = useUiTheme(users, session, 'http://synthetic.invalid');
      return <AppearanceSettings {...appearance} />;
    }
    render(<ThemeProvider><AccountApp /></ThemeProvider>);
    await waitFor(() => expect(screen.getByText('현재 선택 유지 · 계정 저장 확인 실패')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '아쿠아' }));
    await waitFor(() => expect(screen.getByText('현재 선택 유지 · 계정 저장 확인 실패')).toBeTruthy());
    expect(document.documentElement.dataset.lcmTheme).toBe('aqua');
    expect(fetcher.mock.calls.every(call => !call[1].method || call[1].method === 'GET')).toBe(true);
  });
  it('mounted account switch never paints A’s delayed preference on B', async () => {
    const old = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit) => options.headers && (options.headers as Record<string, string>).Authorization === 'Bearer synthetic-A'
      ? old.promise : Promise.resolve(new Response(JSON.stringify({ user: { id: 'B', uiTheme: 'tangerine' } }), { status: 200 }))));
    function AccountApp() {
      const [id, setId] = useState('A');
      const [profiles, setProfiles] = useState<Record<string, AppUser>>({ A: { id: 'server:A', serverUserId: 'A', name: 'A', uiTheme: 'violet' }, B: { id: 'server:B', serverUserId: 'B', name: 'B', uiTheme: 'aqua' } });
      const users = { currentUser: profiles[id], updateTheme: (profile: string, uiTheme: AppUser['uiTheme'], uiThemePending: boolean) => { setProfiles(values => Object.fromEntries(Object.entries(values).map(([key, user]) => [key, user.id === profile ? { ...user, uiTheme, uiThemePending } : user]))); return true; } } as LocalUsersApi;
      const appearance = useUiTheme(users, { token: 'synthetic-' + id, user: { id } } as ServerSession, 'http://synthetic.invalid');
      return <><AppearanceSettings {...appearance} /><button onClick={() => setId('B')}>Switch account</button></>;
    }
    render(<ThemeProvider><AccountApp /></ThemeProvider>);
    expect(document.documentElement.dataset.lcmTheme).toBe('violet');
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    expect(document.documentElement.dataset.lcmTheme).toBe('aqua');
    await waitFor(() => expect(document.documentElement.dataset.lcmTheme).toBe('tangerine'));
    await act(async () => { old.resolve(new Response(JSON.stringify({ user: { id: 'A', uiTheme: 'raspberry' } }), { status: 200 })); await tick(); });
    expect(document.documentElement.dataset.lcmTheme).toBe('tangerine');
  });
  it('persists in real AppUser records, restores A/B on switches and reload, resets on logout', async () => {
    localStorage.setItem(USERS_KEY, JSON.stringify([{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob', uiTheme: 'corrupt' }]));
    localStorage.setItem(ACTIVE_USER_KEY, 'alice');
    const first = render(<ThemeProvider><LocalApp /></ThemeProvider>);
    await waitFor(() => expect(screen.getByLabelText('profile').textContent).toBe('alice'));
    fireEvent.click(screen.getByRole('button', { name: '바이올렛' }));
    expect(document.documentElement.dataset.lcmTheme).toBe('violet');
    expect(JSON.parse(localStorage.getItem(USERS_KEY)!).find((u: AppUser) => u.id === 'alice').uiTheme).toBe('violet');
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
    expect(document.documentElement.dataset.lcmTheme).toBe('jade');
    fireEvent.click(screen.getByRole('button', { name: '아쿠아' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    expect(document.documentElement.dataset.lcmTheme).toBe('violet');
    first.unmount(); render(<ThemeProvider><LocalApp /></ThemeProvider>);
    await waitFor(() => expect(document.documentElement.dataset.lcmTheme).toBe('violet'));
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));
    expect(document.documentElement.dataset.lcmTheme).toBe('jade');
  });
  it('keeps brightness and accent independent with accessible selected controls', async () => {
    render(<ThemeProvider><LocalApp /></ThemeProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '라즈베리' }));
    expect(screen.getByRole('button', { name: '라즈베리' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '어둡게 보기' }));
    expect(document.documentElement.dataset.mantineColorScheme).toBe('dark');
    expect(document.documentElement.dataset.lcmTheme).toBe('raspberry');
    fireEvent.click(screen.getByRole('button', { name: '탠저린' }));
    expect(document.documentElement.dataset.mantineColorScheme).toBe('dark');
    expect(document.documentElement.dataset.lcmTheme).toBe('tangerine');
  });
  it('retains the selection in mounted memory when preference writes are blocked', async () => {
    render(<ThemeProvider><LocalApp /></ThemeProvider>);
    await waitFor(() => expect(screen.getByLabelText('profile').textContent).not.toBe(''));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    fireEvent.click(screen.getByRole('button', { name: '아쿠아' }));
    expect(document.documentElement.dataset.lcmTheme).toBe('aqua');
    expect(screen.getByText('현재 화면에만 적용됨 · 브라우저 저장 불가')).toBeTruthy();
  });
});
