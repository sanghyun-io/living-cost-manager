import { normalizeStoredUiTheme, UI_THEME_IDS, type UiTheme } from '@living-cost-manager/shared';
export { normalizeStoredUiTheme, UI_THEME_IDS };
/** Approved clear-v2 accents; all five share the same neutral surfaces. */
export const themeAccents: Record<UiTheme, { name: string; primary: string; hover: string; active: string; soft: string; ink: string; dark: string }> = {
  jade: { name: '제이드', primary: '#00875F', hover: '#00704F', active: '#00593E', soft: '#E7F5EF', ink: '#006347', dark: '#66DDB0' },
  aqua: { name: '아쿠아', primary: '#007F95', hover: '#006B7E', active: '#005868', soft: '#E6F3F6', ink: '#005D6B', dark: '#70D8EB' },
  violet: { name: '바이올렛', primary: '#6D4AFF', hover: '#5A38E6', active: '#4A2CC0', soft: '#EFEDFF', ink: '#4A2CC0', dark: '#C1B0FF' },
  raspberry: { name: '라즈베리', primary: '#D52C5E', hover: '#B81F4B', active: '#9C173F', soft: '#FBECF1', ink: '#A31D44', dark: '#FF9EBA' },
  tangerine: { name: '탠저린', primary: '#C24F00', hover: '#A84400', active: '#8C3800', soft: '#FBEEE3', ink: '#9A4105', dark: '#FFB477' }
};

export type ThemeAccount = { id: string; token: string; baseUrl: string };
export type ThemeRecord = { theme: UiTheme; pending: boolean };
export type ThemeStatus = 'local' | 'memory' | 'checking' | 'saving' | 'saved' | 'failed';
export function createThemeApi(fetcher: typeof fetch = fetch) {
  return {
    async read(account: ThemeAccount, signal: AbortSignal): Promise<UiTheme> {
      const res = await fetcher(account.baseUrl + '/me', { signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + account.token } });
      if (!res.ok) throw new Error('Theme identity unavailable');
      const body = await res.json();
      if (body?.user?.id !== account.id) throw new Error('Theme identity mismatch');
      if (body.user.uiTheme !== undefined && !UI_THEME_IDS.includes(body.user.uiTheme)) throw new Error('Invalid theme response');
      return normalizeStoredUiTheme(body.user.uiTheme);
    },
    async write(account: ThemeAccount, theme: UiTheme, signal: AbortSignal) {
      const res = await fetcher(account.baseUrl + '/me/theme', { method: 'PUT', signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ uiTheme: theme }) });
      if (!res.ok || (await res.json())?.uiTheme !== theme) throw new Error('Theme save unavailable');
    }
  };
}

/** One scope generation per identity/token. Reads never outrank unsent intent;
 * a single write loop coalesces rapid choices and captures credentials once. */
export function createThemeController(api: ReturnType<typeof createThemeApi>, notify: () => void) {
  let epoch = 0, choice = 0, readGeneration = 0;
  let abort = new AbortController();
  let account: ThemeAccount | null = null;
  let persist: (record: ThemeRecord) => boolean = () => false;
  let alive: () => boolean = () => false;
  let verified = false, busy = false;
  let record: ThemeRecord = { theme: 'jade', pending: false };
  let status: ThemeStatus = 'local';
  const current = (e: number) => e === epoch && !abort.signal.aborted && alive();
  function store() { const durable = persist(record); if (!durable && !account) status = 'memory'; }
  async function flush(e: number) {
    if (!current(e) || !verified || !account || busy || !record.pending) return;
    busy = true;
    const credentials = account, signal = abort.signal;
    try {
      while (current(e) && record.pending) {
        const version = choice, theme = record.theme;
        status = 'saving'; notify();
        try { await api.write(credentials, theme, signal); }
        catch {
          if (!current(e)) return;
          if (version !== choice) continue;
          status = 'failed'; notify(); return;
        }
        if (!current(e)) return;
        if (version === choice) { record = { theme, pending: false }; store(); status = 'saved'; notify(); }
      }
    } finally { if (current(e)) busy = false; }
  }
  async function check(e: number) {
    if (!account || !current(e)) return;
    const credentials = account, read = ++readGeneration, version = choice, hadPending = record.pending;
    status = 'checking'; notify();
    try {
      const remote = await api.read(credentials, abort.signal);
      if (!current(e) || read !== readGeneration) return;
      verified = true;
      if (!record.pending && choice === version && !hadPending) { record = { theme: remote, pending: false }; store(); status = 'saved'; }
      else status = record.pending ? 'local' : 'saved';
      notify(); await flush(e);
    } catch { if (current(e) && read === readGeneration) { verified = false; status = 'failed'; notify(); } }
  }
  return {
    get record() { return record; }, get status() { return status; },
    enter(initial: ThemeRecord, nextAccount: ThemeAccount | null, write: typeof persist, valid: () => boolean) {
      abort.abort(); abort = new AbortController(); ++epoch; choice = 0;
      account = nextAccount; persist = write; alive = valid; verified = false; busy = false;
      record = { theme: normalizeStoredUiTheme(initial.theme), pending: initial.pending }; status = 'local'; notify();
      if (account) void check(epoch);
    },
    choose(theme: UiTheme) {
      if (!alive() || !UI_THEME_IDS.includes(theme)) return;
      ++choice; record = { theme, pending: !!account }; status = 'local'; store(); notify();
      if (account) { if (verified) void flush(epoch); else void check(epoch); }
    },
    retry() { if (account && alive()) void check(epoch); },
    cancel() { abort.abort(); ++epoch; verified = false; }
  };
}
