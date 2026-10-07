"use client";
import { useEffect, useRef, useState } from 'react';
import type { AggregateWorkspacesResponse } from '@living-cost-manager/shared';
import type { ServerAuthApi } from './useServerAuth';
import type { WorkspaceSyncApi } from './useWorkspaceSync';
import type { LocalBudgetSnapshot } from './snapshot';
import { buildWorkspaceSnapshot } from './snapshot';
import { ServerApiError } from './serverApi';

export function useLedgers(auth: ServerAuthApi, sync: WorkspaceSyncApi) {
  const scope = JSON.stringify([auth.serverSession?.user.id, auth.serverSession?.workspace?.id]);
  const accountId = auth.serverSession?.user.id, workspaceId = auth.serverSession?.workspace?.id;
  const epoch = useRef({ scope, accountId, workspaceId });
  if (epoch.current.scope !== scope) epoch.current = { scope, accountId, workspaceId };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [status, setStatus] = useState('');
  const [aggregateMode, setAggregateMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [aggregate, setAggregate] = useState<AggregateWorkspacesResponse | null>(null);
  const requestId = useRef(0);
  const creating = useRef(false);
  useEffect(() => { setBusy(false); setStatus(''); setAggregateMode(false); setSelected([]); setAggregate(null); requestId.current++; }, [scope]);
  const current = (ticket: typeof epoch.current) => mounted.current && ticket === epoch.current && auth.matchesServerScope(ticket.accountId, ticket.workspaceId);

  async function refresh() {
    const ticket = epoch.current;
    try { await sync.loadServerWorkspaces(); if (current(ticket)) { setUncertain(false); setStatus('목록을 확인했습니다. 같은 이름의 새 장부가 이미 있는지 확인한 뒤 생성하세요.'); } }
    catch { if (current(ticket)) setStatus('목록을 확인하지 못했습니다. 생성은 재시도하지 않습니다.'); }
  }
  async function create(name: string, initial?: LocalBudgetSnapshot): Promise<boolean> {
    const session = auth.serverSession, api = auth.serverApi, ticket = epoch.current;
    if (!session || !api || busy || creating.current || uncertain || !session.user.emailVerified) return false;
    const trimmed = name.trim(); if (!trimmed || trimmed.length > 100) return false;
    creating.current = true; setBusy(true); setStatus('');
    try {
      const snapshot = initial ? buildWorkspaceSnapshot('new', initial, 0) : null;
      const initialBudget = snapshot ? {
        monthlyIncome: snapshot.monthlyIncome,
        categories: snapshot.categories.map(({ workspaceId, ...item }) => item),
        cards: snapshot.cards.map(({ workspaceId, ...item }) => item),
        fixedCosts: snapshot.fixedCosts.map(({ workspaceId, ...item }) => item)
      } : { monthlyIncome: 0, categories: [], cards: [], fixedCosts: [] };
      await api.createWorkspace({ name: trimmed, initialBudget }, session.token);
      if (!current(ticket)) return false;
      setStatus('새 장부를 만들었습니다. 기존 장부는 변경하지 않았습니다. 장부 선택에서 새 장부를 고르세요.');
      await sync.loadServerWorkspaces(); return current(ticket);
    } catch (error) {
      if (!current(ticket)) return false;
      // POST has no idempotency key. Network/5xx results may have committed.
      if (!(error instanceof ServerApiError) || error.status >= 500) {
        setUncertain(true); setStatus('생성 결과를 확인할 수 없습니다. 중복 생성을 막기 위해 자동 재시도하지 않습니다. 장부 목록을 새로 확인하세요.');
      } else setStatus('장부 생성에 실패했습니다. 이메일 확인과 입력값을 확인하세요.');
      return false;
    } finally { creating.current = false; if (current(ticket)) setBusy(false); }
  }
  async function rename(name: string) {
    const session = auth.serverSession, api = auth.serverApi, ticket = epoch.current;
    if (!session?.workspace || !api || busy || session.workspace.role !== 'owner' || !session.user.emailVerified || !name.trim()) return;
    setBusy(true);
    try {
      const workspace = await api.renameWorkspace(session.workspace.id, name.trim(), session.token);
      if (!current(ticket)) return;
      const next = { ...session, workspace }; auth.saveServerSession(next); auth.setServerSession(next);
      await sync.loadServerWorkspaces(); if (current(ticket)) setStatus('장부 이름을 변경했습니다.');
    } catch { if (current(ticket)) setStatus('이름을 변경하지 못했습니다. 목록과 소유자 권한을 다시 확인하세요.'); }
    finally { if (current(ticket)) setBusy(false); }
  }
  function select(ids: string[]) { requestId.current++; setSelected([...new Set(ids)].slice(0, 20)); setAggregate(null); }
  async function loadAggregate() {
    const session = auth.serverSession, api = auth.serverApi, ticket = epoch.current, id = ++requestId.current;
    if (!session || !api || selected.length === 0) return;
    setAggregate(null); setBusy(true);
    try { const result = await api.aggregateWorkspaces(selected, session.token); if (current(ticket) && id === requestId.current) setAggregate(result); }
    catch { if (current(ticket) && id === requestId.current) setStatus('합산 결과를 읽지 못했습니다. 권한과 연결을 확인하세요.'); }
    finally { if (current(ticket) && id === requestId.current) setBusy(false); }
  }
  return { busy, uncertain, status, create, rename, refresh, aggregateMode, setAggregateMode: (value: boolean) => { requestId.current++; setBusy(false); setAggregateMode(value); setAggregate(null); }, selected, select, aggregate, loadAggregate };
}
