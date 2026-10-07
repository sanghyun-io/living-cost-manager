"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  InvitationRole,
  WorkspaceDto,
  WorkspaceInvitationDto,
  WorkspaceMemberDto,
  WorkspaceSnapshot
} from "@living-cost-manager/shared";
import {
  buildWorkspaceSnapshot,
  hasLocalBudgetData,
  hydrateWorkspaceSnapshot,
  isWorkspaceSnapshotEmpty
} from "./snapshot";
import { type CreatedInvitation, ServerApiError, type ServerSession, isServerAuthFailure } from "./serverApi";
import { getServerSyncErrorMessage } from "./serverMessages";
import { canManageSharing, canSyncWorkspace, findCurrentMember } from "./sharing";
import { getAccountSyncState, getSyncStateView, summarizeBudgetSnapshot } from "./syncStatus";
import { track } from "./analytics";
import type { AccountSyncState } from "./syncStatus";
import type { UIStateApi } from "./useUIState";
import type { ServerAuthApi } from "./useServerAuth";
import type { BudgetDataApi } from "./useBudgetData";
import type { CoachApi } from "./useCoach";
import { buildLivingCostBackup } from "./backup";
import { getUserDataKey } from "./users";
import { blockSync, canAutoSync, canReplaceLocal, createSyncSafety, establishSyncBaseline, syncScope, syncSnapshotKey as buildSnapshotKey } from "./syncSafety";
import { canCreateFirstOwnedLedger } from './publicRelease';

interface UseWorkspaceSyncOptions {
  ui: UIStateApi;
  auth: ServerAuthApi;
  budget: BudgetDataApi;
  coach: CoachApi;
  /** Required for sync: identity and readiness of the local budget being edited. */
  localUserId?: string | null;
  isLocalDataReady?: boolean;
}

export type WorkspaceListLoadResult =
  | { status: "discarded" }
  | { status: "applied"; workspaces: WorkspaceDto[]; isCurrent: () => boolean };

/**
 * Everything scoped to a server workspace: snapshot sync decisions, upload /
 * download, workspace switching, sharing (members & invitations), plus the
 * derived sync-state view the DataModal renders.
 */
export function useWorkspaceSync({ ui, auth, budget, coach, localUserId = null, isLocalDataReady = false }: UseWorkspaceSyncOptions) {
  const [serverSnapshot, setServerSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [isServerSnapshotChecked, setIsServerSnapshotChecked] = useState(false);
  const [lastServerSyncedAt, setLastServerSyncedAt] = useState<Date | null>(null);
  const [serverWorkspaces, setServerWorkspaces] = useState<WorkspaceDto[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberDto[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitationDto[]>([]);
  const [sentInvitations, setSentInvitations] = useState<WorkspaceInvitationDto[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitationRole>("viewer");
  const [acceptTokens, setAcceptTokens] = useState<Record<string, string>>({});
  const [createdInvitation, setCreatedInvitation] = useState<CreatedInvitation | null>(null);

  const { serverApi, serverSession } = auth;
  const scope = syncScope(localUserId, isLocalDataReady, serverSession?.user.id, serverSession?.workspace?.id);
  const safety = useRef(createSyncSafety(scope));
  const latestBudget = useRef(budget);
  latestBudget.current = budget;
  const latestSession = useRef(serverSession);
  latestSession.current = serverSession;
  const latestLocal = useRef({ localUserId, isLocalDataReady });
  latestLocal.current = { localUserId, isLocalDataReady };
  // Unlike snapshot syncScope, list reads also work without a selected ledger
  // or ready local data. Still invalidate them on every identity/mode change.
  const listScope = JSON.stringify([serverSession?.user.id, serverSession?.workspace?.id, localUserId, isLocalDataReady]);
  const listEpoch = useRef({ scope: listScope });
  if (listEpoch.current.scope !== listScope) listEpoch.current = { scope: listScope };
  const [, renderSafety] = useState(0);
  const notifySafety = () => renderSafety((value) => value + 1);
  if (safety.current.scope !== scope) safety.current = createSyncSafety(scope);
  const checkedScope = useRef<ReturnType<typeof createSyncSafety> | null>(null);
  const sharingScope = useRef<ReturnType<typeof createSyncSafety> | null>(null);
  const decisionRequest = useRef(0);
  const workspaceListRequest = useRef(0);
  const workspaceListProof = useRef<{ workspaces: WorkspaceDto[]; isCurrent: () => boolean } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; safety.current = createSyncSafety(""); };
  }, []);
  useEffect(() => {
    if (!safety.current.busy) auth.setIsServerBusy(false);
  }, [scope]);
  const isActive = (ticket: ReturnType<typeof createSyncSafety>) => mounted.current && safety.current === ticket;
  const isCurrentSession = (session: ServerSession) =>
    latestSession.current?.user.id === session.user.id && latestSession.current?.workspace?.id === session.workspace?.id;
  const isChecked = isServerSnapshotChecked && checkedScope.current === safety.current && !!scope;

  // Refresh the sharing lists while either modal that shows them is open.
  useEffect(() => {
    if ((!ui.isDataModalOpen && !ui.isAuthModalOpen) || !serverSession || !serverApi) {
      return;
    }

    void refreshSharing(serverSession);
  }, [ui.isDataModalOpen, ui.isAuthModalOpen, serverApi, serverSession]);

  // ── derived ──────────────────────────────────────────────────────────
  const currentServerMember = useMemo(
    () => sharingScope.current === safety.current ? findCurrentMember(members, serverSession?.user.id) : undefined,
    [members, serverSession?.user.id, scope]
  );
  const currentWorkspaceRole = currentServerMember?.role ?? serverSession?.workspace?.role ?? null;
  const canManageCurrentWorkspace = canManageSharing(currentWorkspaceRole);
  const canUploadServerSnapshot = canSyncWorkspace(currentWorkspaceRole) && isChecked && !safety.current.blocked;
  const visibleCreatedInvitation =
    canManageCurrentWorkspace && createdInvitation?.workspaceId === serverSession?.workspace?.id ? createdInvitation : null;
  const localSnapshotSummary = useMemo(
    () => summarizeBudgetSnapshot(budget.currentBudgetSnapshot),
    [budget.currentBudgetSnapshot]
  );
  const serverSnapshotSummary = useMemo(
    () => (isChecked && serverSnapshot ? summarizeBudgetSnapshot(hydrateWorkspaceSnapshot(serverSnapshot)) : null),
    [serverSnapshot, isChecked]
  );
  const hasRemoteDecision =
    isChecked && !!serverSnapshot &&
    (!isWorkspaceSnapshotEmpty(serverSnapshot) || hasLocalBudgetData(budget.currentBudgetSnapshot));
  const currentSnapshotKey = useMemo(
    () => buildSnapshotKey(budget.currentBudgetSnapshot),
    [budget.currentBudgetSnapshot]
  );
  const isServerSyncCurrent = safety.current.baseline !== null && currentSnapshotKey === safety.current.baseline;
  const accountSyncState = getAccountSyncState({
    hasServerApi: !!serverApi,
    hasSession: !!serverSession,
    hasWorkspace: !!serverSession?.workspace,
    isBusy: auth.isServerBusy,
    isSnapshotChecked: isChecked,
    hasServerSnapshot: hasRemoteDecision,
    hasAuthFailure: auth.serverErrorKind === "auth",
    hasError: auth.serverErrorKind !== null
  });
  const displayedSyncState: AccountSyncState =
    accountSyncState === "signed-in" && lastServerSyncedAt && isServerSyncCurrent ? "synced" : accountSyncState;
  const syncStateView = getSyncStateView(displayedSyncState);

  // Precomputed here (page used to inline these for the sync panel).
  const showUploadButton = Boolean(
    isChecked && serverSnapshot && isWorkspaceSnapshotEmpty(serverSnapshot) && hasLocalBudgetData(budget.getCurrentBudgetSnapshot())
  );
  const showLoadButton = Boolean(isChecked && serverSnapshot && (!isWorkspaceSnapshotEmpty(serverSnapshot) || safety.current.blocked));

  function setAutoSyncEnabled(enabled: boolean) {
    const state = safety.current;
    state.enabled = enabled && !!state.scope && state.baseline !== null && !state.blocked && isChecked && canSyncWorkspace(currentWorkspaceRole);
    if (enabled && !state.enabled) auth.setServerStatus("먼저 직접 업로드하거나 서버 데이터를 불러온 뒤 자동 동기화를 켜세요.");
    notifySafety();
  }

  useEffect(() => {
    if (!canUploadServerSnapshot || auth.isServerBusy || !canAutoSync(safety.current, currentSnapshotKey)) return;
    const ticket = safety.current;
    const timer = window.setTimeout(() => {
      if (isActive(ticket) && canAutoSync(ticket, buildSnapshotKey(latestBudget.current.getCurrentBudgetSnapshot()))) void uploadSnapshot(true);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [scope, currentSnapshotKey, canUploadServerSnapshot, auth.isServerBusy, safety.current.enabled, safety.current.busy]);

  // ── workspaces & sync decision ───────────────────────────────────────
  async function loadServerWorkspaces(session = serverSession): Promise<WorkspaceListLoadResult> {
    const request = ++workspaceListRequest.current;
    // Keep the old list for access, but never use it to authorize creation
    // while a newer read is pending or failed. Notify even if that read fails.
    workspaceListProof.current = null;
    notifySafety();
    if (!serverApi || !session) {
      setServerWorkspaces([]);
      return { status: "discarded" };
    }

    const ticket = safety.current;
    const epoch = listEpoch.current;
    const accountId = session.user.id, workspaceId = session.workspace?.id;
    const isCurrent = () => isActive(ticket) && epoch === listEpoch.current &&
      latestSession.current?.user.id === accountId && latestSession.current?.workspace?.id === workspaceId &&
      request === workspaceListRequest.current;
    const workspaces = await serverApi.listWorkspaces(session.token);
    if (!isCurrent()) return { status: "discarded" };
    setServerWorkspaces(workspaces);
    workspaceListProof.current = { workspaces, isCurrent };
    return { status: "applied", workspaces, isCurrent };
  }

  async function prepareServerSyncDecision(session: ServerSession) {
    if (latestLocal.current.localUserId !== localUserId || latestLocal.current.isLocalDataReady !== isLocalDataReady) return false;
    if (!serverApi) {
      setIsServerSnapshotChecked(false);
      return false;
    }

    const request = ++decisionRequest.current;
    const localScope = localUserId;
    const expectedScope = syncScope(localScope, isLocalDataReady, session.user.id, session.workspace?.id);
    // Session setters may not have rendered yet; establish the new generation now.
    if (safety.current.scope !== expectedScope) safety.current = createSyncSafety(expectedScope);
    const startingTicket = safety.current;
    startingTicket.enabled = false;
    setIsServerSnapshotChecked(false);
    setServerSnapshot(null);
    // 워크스페이스/세션이 바뀔 수 있는 진입점이므로 세대를 올려 이전 워크스페이스의
    // 진행 중 히스토리 응답을 무효화하고, 활성 scope 를 이 세션으로 맞춘다(이후
    // 이 세션의 refresh 만 커밋 가능). workspace 없으면 scope 는 null.
    coach.invalidateMonthlyReport(session);
    auth.setServerErrorKind(null);

    if (!session.workspace) {
      auth.setServerStatus("계정은 연결됐지만 선택한 가계부가 없습니다. 화면 상단에서 가계부를 선택하거나 새로 만드세요.");
      return false;
    }

    try {
      const remoteSnapshot = await serverApi.getWorkspaceSnapshot(session.workspace.id, session.token);
      if (!isActive(startingTicket) || request !== decisionRequest.current || !expectedScope) return false;
      if (safety.current.baseline !== null && safety.current.version !== remoteSnapshot.syncVersion) blockSync(safety.current);
      if (safety.current.baseline === null && !safety.current.blocked) safety.current.version = remoteSnapshot.syncVersion;
      checkedScope.current = safety.current;
      setServerSnapshot(remoteSnapshot);
      setIsServerSnapshotChecked(true);
      const hydrated = hydrateWorkspaceSnapshot(remoteSnapshot);
      if (latestBudget.current.initializeFreshLedger(hydrated)) {
        establishSyncBaseline(startingTicket, buildSnapshotKey(hydrated), remoteSnapshot.syncVersion);
        setLastServerSyncedAt(new Date());
        auth.setServerStatus('새로 선택한 가계부를 서버에서 불러왔습니다. 기존 가계부와 편집 캐시는 변경하지 않았습니다.');
        void coach.refreshMonthlyReport(session);
        return true;
      }
      // 추세 조각용 히스토리를 백그라운드로 갱신(대기하지 않음 — 동기화 흐름 안 막음).
      void coach.refreshMonthlyReport(session);

      if (isWorkspaceSnapshotEmpty(remoteSnapshot) && hasLocalBudgetData(budget.getCurrentBudgetSnapshot())) {
        auth.setServerStatus("서버 가계부가 비어 있습니다. 이 브라우저 데이터를 업로드할 수 있습니다.");
        return true;
      }

      if (!isWorkspaceSnapshotEmpty(remoteSnapshot)) {
        auth.setServerStatus("서버 데이터가 있습니다. 불러오거나 현재 브라우저 데이터로 동기화할 수 있습니다.");
        return true;
      }

      auth.setServerStatus("서버 가계부와 연결되었습니다. 로컬 전용으로 계속해도 됩니다.");
      return true;
    } catch (error) {
      if (!isActive(startingTicket) || request !== decisionRequest.current) return false;
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error) + " 서버 상태 확인 전에는 업로드를 막습니다. 로컬 저장은 계속 유지됩니다.");
      return false;
    }
  }

  async function handleSelectServerWorkspace(workspaceId: string) {
    if (!serverSession) {
      return;
    }

    const workspace = serverWorkspaces.find((item) => item.id === workspaceId) ?? null;
    if (!workspace || workspace.id === serverSession.workspace?.id) return;
    if (!latestBudget.current.saveBeforeSwitch()) { auth.setServerStatus('현재 가계부를 저장하지 못해 전환하지 않았습니다. 백업을 먼저 내보내세요.'); return; }
    const nextSession = {
      ...serverSession,
      workspace
    };

    safety.current = createSyncSafety("");
    auth.saveServerSession(nextSession);
    auth.setServerSession(nextSession);
    setIsServerSnapshotChecked(false);
    clearWorkspaceScopedSharingDrafts();
    setMembers([]);
    setSentInvitations([]);
    setServerSnapshot(null);
    // 워크스페이스 전환은 신뢰 경계 — 이전 워크스페이스의 추세/진행 중 응답을 버리고
    // 활성 scope 를 새 워크스페이스로 맞춘다(workspace 가 있으면 곧 prepareServerSyncDecision
    // 이 같은 scope 로 다시 설정; 없는 경로는 null 로 남아 어떤 응답도 커밋 안 됨).
    coach.invalidateMonthlyReport(nextSession);
    // The page prepares sync only AFTER the target ledger's local cache loads.
  }

  async function handleSyncNow() {
    await uploadSnapshot(false);
  }

  async function uploadSnapshot(automatic: boolean) {
    if (!serverApi || !serverSession?.workspace) {
      auth.setServerStatus("동기화할 서버 가계부가 없습니다.");
      return;
    }

    const ticket = safety.current;
    if (ticket.busy || auth.isServerBusy) return;
    if (!canUploadServerSnapshot || !ticket.scope || ticket.blocked || ticket.version === null) {
      auth.setServerStatus(ticket.blocked ? "동기화가 중단되었습니다. 로컬 데이터를 백업한 뒤 서버 데이터를 다시 불러오세요." : isChecked ? "보기 전용 권한은 서버에 업로드할 수 없습니다." : "로컬 사용자와 서버 상태 확인이 끝난 뒤 업로드할 수 있습니다.");
      return;
    }

    if (automatic && !canAutoSync(ticket, buildSnapshotKey(latestBudget.current.getCurrentBudgetSnapshot()))) return;
    if (!automatic && ticket.baseline === null && serverSnapshot && !isWorkspaceSnapshotEmpty(serverSnapshot) &&
        !window.confirm("서버의 전체 데이터를 현재 브라우저 데이터로 교체할까요? 다른 기기의 데이터도 교체됩니다.")) return;
    ticket.busy = true;
    const outgoing = latestBudget.current.getCurrentBudgetSnapshot();
    const outgoingKey = buildSnapshotKey(outgoing);
    auth.setIsServerBusy(true);
    try {
      // 마지막으로 읽은 서버 버전을 실어 보낸다. 서버가 이 값과 현재 DB 값을
      // 비교해 동시 편집 충돌(409)을 판정한다.
      const nextSnapshot = buildWorkspaceSnapshot(
        serverSession.workspace.id,
        outgoing,
        ticket.version
      );
      const savedSnapshot = await serverApi.putWorkspaceSnapshot(serverSession.workspace.id, nextSnapshot, serverSession.token);
      if (!isActive(ticket)) return;
      establishSyncBaseline(ticket, outgoingKey, savedSnapshot.syncVersion);
      setServerSnapshot(savedSnapshot);
      setLastServerSyncedAt(new Date());
      auth.setServerErrorKind(null);
      auth.setServerStatus("현재 브라우저 데이터를 서버에 동기화했습니다.");
      track({ type: "sync.push", timestamp: Date.now(), data: { workspaceId: serverSession.workspace.id } });
      // 방금 업로드가 새 히스토리 엔트리가 되므로 추세를 다시 계산해 둔다.
      // (업로드 await 중 전환이 있었다면 serverSession 의 scope 가 활성 scope 와
      //  달라 refreshMonthlyReport 가 커밋 단계에서 스스로 폐기한다.)
      void coach.refreshMonthlyReport(serverSession);
    } catch (error) {
      if (!isActive(ticket)) return;
      // Do not adopt a new version and retry a whole-snapshot overwrite.
      blockSync(ticket);
      // A conflict stays blocked until an explicit fresh load establishes a baseline.
      if (error instanceof ServerApiError && error.status === 409) {
        auth.setServerErrorKind("request");
        auth.setServerStatus("다른 기기나 멤버가 먼저 저장해 충돌이 났습니다. 서버 데이터를 다시 불러온 뒤 동기화하세요. 로컬 저장은 계속 유지됩니다.");
        return;
      }
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error) + " 로컬 저장은 계속 유지됩니다.");
    } finally {
      ticket.busy = false;
      if (isActive(ticket)) { auth.setIsServerBusy(false); notifySafety(); }
    }
  }

  async function handleLoadServerSnapshot() {
    if (!serverApi || !serverSession?.workspace) {
      auth.setServerStatus("불러올 서버 가계부가 없습니다.");
      return;
    }

    const ticket = safety.current;
    if (!ticket.scope || ticket.busy || auth.isServerBusy) return;
    if (!window.confirm("현재 브라우저 데이터를 복구용 백업으로 저장한 뒤 서버 데이터로 교체할까요?")) return;
    ticket.enabled = false;
    ticket.busy = true;
    const before = buildSnapshotKey(latestBudget.current.getCurrentBudgetSnapshot());
    auth.setIsServerBusy(true);
    try {
      const nextSnapshot = await serverApi.getWorkspaceSnapshot(serverSession.workspace.id, serverSession.token);
      if (!isActive(ticket)) return;
      const local = latestBudget.current.getCurrentBudgetSnapshot();
      if (!canReplaceLocal(ticket, safety.current, before, buildSnapshotKey(local))) {
        auth.setServerStatus("불러오는 동안 로컬 데이터가 변경되어 교체하지 않았습니다. 다시 확인 후 불러오세요.");
        return;
      }
      const backupKey = getUserDataKey(localUserId!) + ":recovery:" + Date.now() + ":sync:" + crypto.randomUUID();
      const backup = buildLivingCostBackup(local);
      window.localStorage.setItem(backupKey, backup);
      if (window.localStorage.getItem(backupKey) !== backup) throw new Error("Recovery backup failed");
      const hydrated = hydrateWorkspaceSnapshot(nextSnapshot);
      latestBudget.current.applyBudgetSnapshot(hydrated);
      establishSyncBaseline(ticket, buildSnapshotKey(hydrated), nextSnapshot.syncVersion);
      checkedScope.current = ticket;
      setIsServerSnapshotChecked(true);
      setServerSnapshot(nextSnapshot);
      setLastServerSyncedAt(new Date());
      auth.setServerErrorKind(null);
      auth.setServerStatus("서버 데이터를 불러왔습니다. 이전 데이터 복구 백업: " + backupKey);
      track({ type: "sync.pull", timestamp: Date.now(), data: { workspaceId: serverSession.workspace.id } });
      // 복원 직후에도 히스토리 기반 추세를 채워 코치 입력에 반영한다.
      void coach.refreshMonthlyReport(serverSession);
    } catch (error) {
      if (!isActive(ticket)) return;
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error) + " 로컬 데이터는 변경하지 않았습니다.");
    } finally {
      ticket.busy = false;
      if (isActive(ticket)) { auth.setIsServerBusy(false); notifySafety(); }
    }
  }

  function handleStayLocalOnly() {
    setAutoSyncEnabled(false);
    auth.setServerStatus("로컬 전용으로 계속합니다. 서버 연결은 유지되지만 데이터를 덮어쓰지 않습니다.");
  }

  // ── server-logout / auth-failure teardown (called from useServerAuth) ──
  function resetOnServerLogout() {
    safety.current = createSyncSafety("");
    decisionRequest.current += 1;
    // 진행 중인 히스토리 응답을 무효화하고 이전 사용자 추세를 즉시 비운다.
    setServerSnapshot(null);
    coach.invalidateMonthlyReport();
    setIsServerSnapshotChecked(false);
    setServerWorkspaces([]);
    setMembers([]);
    setInvitations([]);
    setSentInvitations([]);
    setLastServerSyncedAt(null);
    clearWorkspaceScopedSharingDrafts();
  }

  // Session invalidated while restoring (refresh token dead too): clears less
  // than a full logout — exactly the original page-level sequence.
  function dropSessionOnAuthFailure() {
    safety.current = createSyncSafety("");
    decisionRequest.current += 1;
    setServerWorkspaces([]);
    coach.invalidateMonthlyReport();
    setIsServerSnapshotChecked(false);
  }

  // ── sharing ──────────────────────────────────────────────────────────
  async function refreshSharing(session = serverSession) {
    if (!serverApi || !session) {
      return;
    }

    // Only workspace owners may list the invitations they've sent (server
    // returns 403 otherwise), so guard the call by role.
    const ticket = safety.current;
    const isOwner = session.workspace?.role === "owner";

    try {
      const [nextMembers, nextInvitations, nextSentInvitations] = await Promise.all([
        session.workspace ? serverApi.listMembers(session.workspace.id, session.token) : Promise.resolve([]),
        serverApi.listInvitations(session.token),
        session.workspace && isOwner
          ? serverApi.listWorkspaceInvitations(session.workspace.id, session.token)
          : Promise.resolve([])
      ]);
      if (!isActive(ticket) || !isCurrentSession(session)) return;
      sharingScope.current = ticket;
      setMembers(nextMembers);
      setInvitations(nextInvitations);
      setSentInvitations(nextSentInvitations);
      auth.setServerErrorKind(null);
    } catch (error) {
      if (!isActive(ticket) || !isCurrentSession(session)) return;
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    }
  }

  async function handleCreateInvitation() {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    const ticket = safety.current;
    auth.setIsServerBusy(true);
    try {
      const invitation = await serverApi.createInvitation(serverSession.workspace.id, { email: inviteEmail, role: inviteRole }, serverSession.token);
      if (!isActive(ticket) || !isCurrentSession(serverSession)) return;
      setCreatedInvitation(invitation);
      setInviteEmail("");
      auth.setServerStatus("초대를 만들었습니다. 아래 토큰을 초대받은 사용자에게 전달하세요.");
      auth.setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      if (!isActive(ticket) || !isCurrentSession(serverSession)) return;
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      if (isActive(ticket)) auth.setIsServerBusy(false);
    }
  }

  async function handleAcceptInvitation(invitationId: string) {
    if (!serverApi || !serverSession) {
      return;
    }

    const tokenValue = acceptTokens[invitationId]?.trim() ?? "";
    if (!tokenValue) {
      auth.setServerStatus("초대 토큰을 입력하세요.");
      return;
    }

    if (!latestBudget.current.saveBeforeSwitch()) { auth.setServerStatus('현재 가계부 저장을 확인한 뒤 초대를 수락하세요.'); return; }

    const ticket = safety.current;
    auth.setIsServerBusy(true);
    try {
      const accepted = await serverApi.acceptInvitation(invitationId, tokenValue, serverSession.token);
      if (!isActive(ticket) || !isCurrentSession(serverSession)) return;
      const nextSession = await auth.resolveAndStoreServerSession({ ...serverSession, workspace: accepted.workspace });
      if (latestLocal.current.localUserId !== localUserId || latestLocal.current.isLocalDataReady !== isLocalDataReady) return;
      clearWorkspaceScopedSharingDrafts();
      auth.setServerStatus("초대를 수락했습니다. 새 가계부가 선택되었습니다.");
      auth.setServerErrorKind(null);
      if (await prepareServerSyncDecision(nextSession)) await refreshSharing(nextSession);
    } catch (error) {
      if (!isActive(ticket)) return;
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      if (isActive(ticket)) auth.setIsServerBusy(false);
    }
  }

  async function handleUpdateMemberRole(memberId: string, role: WorkspaceMemberDto["role"]) {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    const ticket = safety.current;
    auth.setIsServerBusy(true);
    try {
      await serverApi.updateMemberRole(serverSession.workspace.id, memberId, role, serverSession.token);
      if (!isActive(ticket) || !isCurrentSession(serverSession)) return;
      auth.setServerStatus("멤버 권한을 변경했습니다.");
      auth.setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      if (!isActive(ticket)) return;
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      if (isActive(ticket)) auth.setIsServerBusy(false);
    }
  }

  async function handleDeleteMember(memberId: string) {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    if (!window.confirm("이 멤버를 가계부에서 제거할까요?")) {
      return;
    }

    const ticket = safety.current;
    auth.setIsServerBusy(true);
    try {
      await serverApi.deleteMember(serverSession.workspace.id, memberId, serverSession.token);
      if (!isActive(ticket) || !isCurrentSession(serverSession)) return;
      auth.setServerStatus("멤버를 제거했습니다.");
      auth.setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      if (!isActive(ticket)) return;
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      if (isActive(ticket)) auth.setIsServerBusy(false);
    }
  }

  async function handleRevokeInvitation(invitationId: string) {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    if (!window.confirm("이 초대를 취소할까요? 취소된 초대 링크는 더 이상 사용할 수 없습니다.")) {
      return;
    }

    const ticket = safety.current;
    auth.setIsServerBusy(true);
    try {
      await serverApi.revokeInvitation(serverSession.workspace.id, invitationId, serverSession.token);
      if (!isActive(ticket) || !isCurrentSession(serverSession)) return;
      auth.setServerStatus("초대를 취소했습니다.");
      auth.setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      if (!isActive(ticket)) return;
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      if (isActive(ticket)) auth.setIsServerBusy(false);
    }
  }

  function clearWorkspaceScopedSharingDrafts() {
    setCreatedInvitation(null);
    setInviteEmail("");
    setInviteRole("viewer");
    setAcceptTokens({});
  }

  return {
    autoSyncEnabled: safety.current.enabled,
    canEnableAutoSync: isChecked && safety.current.baseline !== null && !safety.current.blocked && canSyncWorkspace(currentWorkspaceRole),
    isSyncBlocked: safety.current.blocked,
    setAutoSyncEnabled,
    serverSnapshot: isChecked ? serverSnapshot : null,
    setIsServerSnapshotChecked,
    isServerSnapshotChecked: isChecked,
    lastServerSyncedAt: safety.current.baseline !== null ? lastServerSyncedAt : null,
    serverWorkspaces,
    isWorkspaceListChecked: !!workspaceListProof.current?.isCurrent(),
    canCreateFirstOwnedLedger: canCreateFirstOwnedLedger(workspaceListProof.current?.workspaces ?? [], !!workspaceListProof.current?.isCurrent()),
    // Event-time proof also protects an older template handler resumed after
    // an async shared-link check. A render-time boolean is not authorization.
    canCreateFirstOwnedLedgerNow: () => canCreateFirstOwnedLedger(workspaceListProof.current?.workspaces ?? [], !!workspaceListProof.current?.isCurrent()),
    members,
    invitations,
    sentInvitations,
    inviteEmail,
    setInviteEmail,
    inviteRole,
    setInviteRole,
    acceptTokens,
    setAcceptTokens,
    createdInvitation,
    // derived
    currentServerMember,
    currentWorkspaceRole,
    canManageCurrentWorkspace,
    canUploadServerSnapshot,
    visibleCreatedInvitation,
    localSnapshotSummary,
    serverSnapshotSummary,
    hasRemoteDecision,
    currentSnapshotKey,
    isServerSyncCurrent,
    accountSyncState,
    displayedSyncState,
    syncStateView,
    showUploadButton,
    showLoadButton,
    // handlers
    loadServerWorkspaces,
    prepareServerSyncDecision,
    handleSelectServerWorkspace,
    handleSyncNow,
    handleLoadServerSnapshot,
    handleStayLocalOnly,
    refreshSharing,
    handleCreateInvitation,
    handleAcceptInvitation,
    handleUpdateMemberRole,
    handleDeleteMember,
    handleRevokeInvitation,
    resetOnServerLogout,
    dropSessionOnAuthFailure
  };
}

export type WorkspaceSyncApi = ReturnType<typeof useWorkspaceSync>;
