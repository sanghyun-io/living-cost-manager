"use client";
import { useEffect, useRef, useState } from 'react';
import type { AggregateWorkspacesResponse } from '@living-cost-manager/shared';
import type { ServerAuthApi } from './useServerAuth';
import type { WorkspaceSyncApi } from './useWorkspaceSync';
import type { LocalBudgetSnapshot } from './snapshot';
import { buildWorkspaceSnapshot } from './snapshot';
import { ServerApiError } from './serverApi';

type Mutation = { pending: boolean; uncertain: boolean; name: string; status: string; listReviewed: boolean; reviewCurrent?: () => boolean };
export const ledgerCreationKey = (accountId: string) => 'living-cost-manager:ledger-creation:' + encodeURIComponent(accountId);
export function useLedgers(auth: ServerAuthApi, sync: WorkspaceSyncApi) {
  const accountId = auth.serverSession?.user.id, workspaceId = auth.serverSession?.workspace?.id;
  const scope = JSON.stringify([accountId, workspaceId]);
  const epoch = useRef({ scope, accountId, workspaceId });
  if (epoch.current.scope !== scope) epoch.current = { scope, accountId, workspaceId };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const mutations = useRef(new Map<string, Mutation>());
  function mutation(id: string): Mutation {
    let value = mutations.current.get(id);
    if (!value) {
      let name = '';
      if (typeof window !== 'undefined') try { name = window.localStorage.getItem(ledgerCreationKey(id)) ?? ''; } catch { name = '미확인'; }
      value = { pending: false, uncertain: !!name, name, listReviewed: false, status: name ? '이 계정의 가계부 생성 결과가 미확인입니다. 목록을 직접 확인하세요. 자동 재시도하지 않습니다.' : '' };
      mutations.current.set(id, value);
    }
    return value;
  }
  const [, render] = useState(0);
  const notify = () => { if (mounted.current) render(value => value + 1); };
  const activeMutation = accountId ? mutation(accountId) : null;
  const [reading, setReading] = useState(false);
  const [status, setStatus] = useState('');
  const [aggregateMode, setAggregateMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [aggregate, setAggregate] = useState<AggregateWorkspacesResponse | null>(null);
  const requestId = useRef(0);
  const listRequestId = useRef(0);
  useEffect(() => { setReading(false); setStatus(''); setAggregateMode(false); setSelected([]); setAggregate(null); requestId.current++; }, [scope]);
  const current = (ticket: typeof epoch.current) => mounted.current && ticket === epoch.current && auth.matchesServerScope(ticket.accountId, ticket.workspaceId);

  async function refresh() {
    const ticket = epoch.current;
    const request = ++listRequestId.current;
    if (!accountId) return;
    const state = mutation(accountId);
    state.listReviewed = false; state.reviewCurrent = undefined;
    state.status = '가계부 목록을 확인 중입니다. 이전 목록은 아직 검토되지 않았습니다.';
    setStatus(''); notify();
    try {
      const result = await sync.loadServerWorkspaces();
      if (!current(ticket) || request !== listRequestId.current) return;
      if (result.status !== 'applied' || !result.isCurrent()) {
        state.status = '목록 응답이 무효화되어 이전 목록을 유지합니다. 새로 확인하기 전에는 생성 결과를 확인할 수 없습니다.';
        notify(); return;
      }
      state.listReviewed = true;
      state.reviewCurrent = () => current(ticket) && request === listRequestId.current && result.isCurrent();
      state.status = state.uncertain ? '최신 가계부 목록을 표시했습니다. 같은 이름의 가계부가 있는지 직접 확인하세요. 목록에 없어도 지연 완료될 수 있어 생성 실패를 확정할 수 없습니다.' : '가계부 목록을 확인했습니다.';
      notify(); return result.workspaces;
    } catch { if (current(ticket) && request === listRequestId.current) { state.status = '목록을 확인하지 못했습니다. 이전 목록은 검토되지 않았으며 생성은 재시도하지 않습니다.'; setStatus(state.status); notify(); } }
  }
  function acknowledgeReconciliation() {
    if (!accountId) return;
    const state = mutation(accountId);
    if (state.pending || !state.uncertain || !state.listReviewed || !state.reviewCurrent?.()) return;
    try { window.localStorage.removeItem(ledgerCreationKey(accountId)); }
    catch { state.status = '확인 상태를 저장하지 못했습니다. 생성 재시도는 중단합니다.'; notify(); return; }
    state.uncertain = false; state.status = '목록을 직접 확인한 뒤 재시도를 허용했습니다. 서버의 지연 완료로 중복이 생길 수 있으며 자동 재시도하지 않습니다.'; notify();
  }
  async function create(name: string, initial?: LocalBudgetSnapshot): Promise<boolean> {
    const session = auth.serverSession, api = auth.serverApi, ticket = epoch.current;
    if (!session || !api || !session.user.emailVerified) return false;
    const state = mutation(session.user.id), trimmed = name.trim();
    if (state.pending || state.uncertain || !trimmed || trimmed.length > 100) return false;
    try {
      const unresolved = window.localStorage.getItem(ledgerCreationKey(session.user.id));
      if (unresolved) { state.uncertain = true; state.name = unresolved; state.listReviewed = false; state.status = '이 계정의 다른 요청 결과가 미확인입니다. 가계부 목록을 직접 확인하세요.'; notify(); return false; }
    } catch { state.status = '생성 확인 상태를 읽지 못해 요청을 보내지 않았습니다.'; notify(); return false; }
    // Record uncertainty BEFORE sending. Reload/account/workspace transitions
    // must never turn a possibly committed POST into a blind repeat.
    try { window.localStorage.setItem(ledgerCreationKey(session.user.id), trimmed); }
    catch { state.status = '생성 확인 상태를 저장하지 못해 요청을 보내지 않았습니다.'; notify(); return false; }
    state.pending = true; state.name = trimmed; state.listReviewed = false; state.status = '가계부 생성 요청 처리 중입니다. 같은 계정의 추가 생성과 이름 변경은 잠시 중단합니다.'; notify();
    try {
      const snapshot = initial ? buildWorkspaceSnapshot('new', initial, 0) : null;
      const initialBudget = snapshot ? {
        monthlyIncome: snapshot.monthlyIncome,
        categories: snapshot.categories.map(({ workspaceId, ...item }) => item),
        cards: snapshot.cards.map(({ workspaceId, ...item }) => item),
        fixedCosts: snapshot.fixedCosts.map(({ workspaceId, ...item }) => item)
      } : { monthlyIncome: 0, categories: [], cards: [], fixedCosts: [] };
      await api.createWorkspace({ name: trimmed, initialBudget }, session.token);
      state.uncertain = false;
      window.localStorage.removeItem(ledgerCreationKey(session.user.id));
      state.status = '새 가계부를 만들었습니다. 기존 가계부는 변경하지 않았습니다. 위 가계부 선택에서 새 가계부를 고르세요.';
      if (current(ticket)) {
        const result = await sync.loadServerWorkspaces().catch(() => null);
        if (!result || result.status !== 'applied' || !result.isCurrent()) state.status += ' 목록 새로고침이 필요합니다.';
      }
      return current(ticket);
    } catch (error) {
      // Account-owned outcome is recorded EVEN IF the selected-ledger epoch or
      // authenticated account has changed. Only the current account displays it.
      if (!(error instanceof ServerApiError) || error.status >= 500) {
        state.uncertain = true; state.status = '생성 결과를 확인할 수 없습니다. 중복 생성을 막기 위해 자동 재시도하지 않습니다. 가계부 목록을 새로 확인하세요.';
      } else {
        try { window.localStorage.removeItem(ledgerCreationKey(session.user.id)); state.uncertain = false; state.status = '가계부 생성에 실패했습니다. 이메일 확인과 입력값을 확인하세요.'; }
        catch { state.uncertain = true; state.status = '실패 응답을 받았지만 확인 상태를 저장하지 못했습니다. 목록 확인 전에는 생성하지 않습니다.'; }
      }
      return false;
    } finally { state.pending = false; notify(); }
  }
  async function rename(name: string) {
    const session = auth.serverSession, api = auth.serverApi, ticket = epoch.current;
    if (!session?.workspace || !api || session.workspace.role !== 'owner' || !session.user.emailVerified || !name.trim()) return;
    const state = mutation(session.user.id); if (state.pending || state.uncertain) return;
    state.pending = true; notify();
    try {
      const workspace = await api.renameWorkspace(session.workspace.id, name.trim(), session.token);
      if (!current(ticket)) return;
      const next = { ...session, workspace }; auth.saveServerSession(next); auth.setServerSession(next);
      await sync.loadServerWorkspaces(); if (current(ticket)) state.status = '가계부 이름을 변경했습니다.';
    } catch { if (current(ticket)) state.status = '이름을 변경하지 못했습니다. 목록과 소유자 권한을 다시 확인하세요.'; }
    finally { state.pending = false; notify(); }
  }
  function select(ids: string[]) { requestId.current++; setSelected([...new Set(ids)].slice(0, 20)); setAggregate(null); }
  async function loadAggregate() {
    const session = auth.serverSession, api = auth.serverApi, ticket = epoch.current, id = ++requestId.current;
    if (!session || !api || selected.length === 0) return;
    setAggregate(null); setReading(true);
    try { const result = await api.aggregateWorkspaces(selected, session.token); if (current(ticket) && id === requestId.current) setAggregate(result); }
    catch { if (current(ticket) && id === requestId.current) setStatus('합산 결과를 읽지 못했습니다. 권한과 연결을 확인하세요.'); }
    finally { if (current(ticket) && id === requestId.current) setReading(false); }
  }
  const reconciliationReady = !!activeMutation?.listReviewed && !!activeMutation.reviewCurrent?.();
  const mutationStatus = activeMutation?.uncertain && activeMutation.listReviewed && !reconciliationReady
    ? '목록 확인 이후 상태가 변경되었습니다. 이전 목록으로 생성 결과를 확인하지 말고 다시 새로고침하세요.' : activeMutation?.status ?? '';
  return { busy: reading || !!activeMutation?.pending, mutationPending: !!activeMutation?.pending,
    uncertain: !!activeMutation?.uncertain, uncertainName: activeMutation?.name ?? '', reconciliationReady,
    status: activeMutation?.pending || activeMutation?.uncertain ? mutationStatus : status || mutationStatus, create, rename, refresh, acknowledgeReconciliation,
    aggregateMode, setAggregateMode: (value: boolean) => { requestId.current++; setReading(false); setAggregateMode(value); setAggregate(null); }, selected, select, aggregate, loadAggregate };
}
