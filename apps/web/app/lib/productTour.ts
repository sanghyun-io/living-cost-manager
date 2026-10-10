/** Product-tour preferences only. Never reads or writes budget/session storage. */
export type TourStatus = 'unseen' | 'completed' | 'skipped';
export type TourResponse = { version: 1; status: TourStatus; updatedAt: string | null };
export type TourRecord = { version: 1; status: TourStatus; pending: boolean };
export type TourStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const tourKey = (scope: string) => 'living-cost-manager:product-tour:v1:' + encodeURIComponent(scope);
export function parseTourResponse(value: unknown): TourResponse {
  if (!value || typeof value !== 'object') throw new Error('Invalid tour response');
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !['unseen', 'completed', 'skipped'].includes(String(v.status)) ||
    !(v.updatedAt === null || (typeof v.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v.updatedAt) && Number.isFinite(Date.parse(v.updatedAt))))) {
    throw new Error('Invalid tour response');
  }
  return v as TourResponse;
}
export function mergeTourStatus(local: TourStatus, incoming: TourStatus): TourStatus {
  return local === 'completed' || incoming === 'completed' ? 'completed' :
    local === 'skipped' || incoming === 'skipped' ? 'skipped' : 'unseen';
}
export function createTourStorage(storage: () => TourStorage | null) {
  const memory = new Map<string, TourRecord>();
  return {
    read(scope: string): TourRecord {
      if (memory.has(scope)) return memory.get(scope)!;
      let record: TourRecord = { version: 1, status: 'unseen', pending: false };
      try {
        const raw = storage()?.getItem(tourKey(scope));
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed?.version === 1 && ['unseen', 'completed', 'skipped'].includes(parsed.status) && typeof parsed.pending === 'boolean') record = parsed;
      } catch { /* unavailable/corrupt storage: safe page-local fallback */ }
      memory.set(scope, record);
      return record;
    },
    write(scope: string, record: TourRecord) {
      memory.set(scope, record);
      try { storage()?.setItem(tourKey(scope), JSON.stringify(record)); } catch { /* memory remains authoritative */ }
    }
  };
}
export type TourAccount = { id: string; token: string; baseUrl: string };
export function createTourApi(fetcher: typeof fetch = fetch) {
  async function request(account: TourAccount, signal: AbortSignal, status?: Exclude<TourStatus, 'unseen'>) {
    const response = await fetcher(account.baseUrl + '/onboarding/product-tour', {
      method: status ? 'PUT' : 'GET', signal, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + account.token, ...(status ? { 'Content-Type': 'application/json' } : {}) },
      ...(status ? { body: JSON.stringify({ version: 1, status }) } : {})
    });
    if (!response.ok) throw new Error('Tour unavailable');
    return parseTourResponse(await response.json());
  }
  return {
    async verify(account: TourAccount, signal: AbortSignal) {
      const response = await fetcher(account.baseUrl + '/me', { signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + account.token } });
      if (!response.ok || (await response.json())?.user?.id !== account.id) throw new Error('Tour identity unavailable');
    },
    get: (account: TourAccount, signal: AbortSignal) => request(account, signal),
    put: (account: TourAccount, signal: AbortSignal, status: Exclude<TourStatus, 'unseen'>) => request(account, signal, status)
  };
}

/** Every transition invalidates requests, including ledger/sample changes within one account. */
export function createTourController(store: ReturnType<typeof createTourStorage>, api: ReturnType<typeof createTourApi>, notify: () => void) {
  let generation = 0;
  let abort = new AbortController();
  let scope = '';
  let lastScope = '';
  let account: TourAccount | null = null;
  let verified = false;
  let flushing = false;
  let invitation = false;
  const invited = new Set<string>();
  const suppressed = new Set<string>();
  const current = (g: number) => g === generation && !abort.signal.aborted;
  async function flush(g: number) {
    if (!current(g) || !verified || !account || flushing) return;
    const target = account;
    const targetScope = scope;
    const record = store.read(targetScope);
    if (!record.pending || record.status === 'unseen') return;
    flushing = true;
    try {
      const response = await api.put(target, abort.signal, record.status);
      if (!current(g)) return;
      const latest = store.read(targetScope);
      const status = mergeTourStatus(latest.status, response.status);
      store.write(targetScope, { version: 1, status, pending: status !== response.status });
    } catch { /* retry only after a successful same-account GET or explicit finish */ }
    finally {
      if (current(g)) { flushing = false; notify(); }
    }
    if (current(g) && store.read(targetScope).pending && store.read(targetScope).status !== record.status) void flush(g);
  }
  return {
    get invitation() { return invitation; },
    get status() { return scope ? store.read(scope).status : 'unseen'; },
    async enter(nextScope: string, nextAccount: TourAccount | null) {
      const previous = lastScope;
      if (previous.startsWith('local:') && store.read(previous).status !== 'unseen' && nextAccount) suppressed.add(nextScope);
      abort.abort(); abort = new AbortController();
      const g = ++generation;
      scope = nextScope;
      account = nextAccount && nextScope === 'account:' + nextAccount.id ? nextAccount : null;
      verified = false; flushing = false; invitation = false;
      if (nextScope) lastScope = nextScope;
      notify();
      if (!scope) return;
      if (scope.startsWith('account:') && !account) return; // unavailable API: manual only
      if (account) {
        try {
          await api.verify(account, abort.signal);
          if (!current(g)) return;
          const response = await api.get(account, abort.signal);
          if (!current(g)) return;
          verified = true;
          const local = store.read(scope);
          const status = mergeTourStatus(local.status, response.status);
          store.write(scope, { version: 1, status, pending: local.pending && status !== response.status });
          void flush(g);
        } catch { return; /* no automatic invitation on API errors */ }
      }
      if (!current(g)) return;
      invitation = !scope.startsWith('sample:') && store.read(scope).status === 'unseen' && !invited.has(scope) && !suppressed.has(scope);
      if (invitation) invited.add(scope);
      notify();
    },
    dismissInvitation() { invitation = false; notify(); },
    finish(status: Exclude<TourStatus, 'unseen'>) {
      if (!scope) return;
      invitation = false;
      const before = store.read(scope);
      const merged = mergeTourStatus(before.status, status);
      store.write(scope, { version: 1, status: merged, pending: before.pending || (scope.startsWith('account:') && merged !== before.status) });
      notify(); void flush(generation);
    },
    cancel() { abort.abort(); ++generation; invitation = false; }
  };
}
