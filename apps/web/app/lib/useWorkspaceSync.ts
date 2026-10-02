"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  InvitationRole,
  WorkspaceDto,
  WorkspaceInvitationDto,
  WorkspaceMemberDto,
  WorkspaceSnapshot
} from "@living-cost-manager/shared";
import {
  buildWorkspaceSnapshot,
  buildSnapshotKey,
  hasLocalBudgetData,
  hydrateWorkspaceSnapshot,
  isWorkspaceSnapshotEmpty
} from "./snapshot";
import { type CreatedInvitation, ServerApiError, type ServerSession, isServerAuthFailure } from "./serverApi";
import { getServerSyncErrorMessage } from "./serverMessages";
import { canManageSharing, canSyncWorkspace, findCurrentMember } from "./sharing";
import { getAccountSyncState, getSyncStateView, summarizeBudgetSnapshot } from "./syncStatus";
import type { AccountSyncState } from "./syncStatus";
import type { UIStateApi } from "./useUIState";
import type { ServerAuthApi } from "./useServerAuth";
import type { BudgetDataApi } from "./useBudgetData";
import type { CoachApi } from "./useCoach";

interface UseWorkspaceSyncOptions {
  ui: UIStateApi;
  auth: ServerAuthApi;
  budget: BudgetDataApi;
  coach: CoachApi;
}

/**
 * Everything scoped to a server workspace: snapshot sync decisions, upload /
 * download, workspace switching, sharing (members & invitations), plus the
 * derived sync-state view the DataModal renders.
 */
export function useWorkspaceSync({ ui, auth, budget, coach }: UseWorkspaceSyncOptions) {
  const [serverSnapshot, setServerSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [isServerSnapshotChecked, setIsServerSnapshotChecked] = useState(false);
  const [lastServerSyncedAt, setLastServerSyncedAt] = useState<Date | null>(null);
  const [lastSyncedSnapshotKey, setLastSyncedSnapshotKey] = useState("");
  const [serverWorkspaces, setServerWorkspaces] = useState<WorkspaceDto[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberDto[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitationDto[]>([]);
  const [sentInvitations, setSentInvitations] = useState<WorkspaceInvitationDto[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitationRole>("viewer");
  const [acceptTokens, setAcceptTokens] = useState<Record<string, string>>({});
  const [createdInvitation, setCreatedInvitation] = useState<CreatedInvitation | null>(null);

  const { serverApi, serverSession } = auth;

  // Refresh the sharing lists while either modal that shows them is open.
  useEffect(() => {
    if ((!ui.isDataModalOpen && !ui.isAuthModalOpen) || !serverSession || !serverApi) {
      return;
    }

    void refreshSharing(serverSession);
  }, [ui.isDataModalOpen, ui.isAuthModalOpen, serverApi, serverSession]);

  // ── derived ──────────────────────────────────────────────────────────
  const currentServerMember = useMemo(
    () => findCurrentMember(members, serverSession?.user.id),
    [members, serverSession?.user.id]
  );
  const currentWorkspaceRole = currentServerMember?.role ?? serverSession?.workspace?.role ?? null;
  const canManageCurrentWorkspace = canManageSharing(currentWorkspaceRole);
  const canUploadServerSnapshot = canSyncWorkspace(currentWorkspaceRole) && isServerSnapshotChecked;
  const visibleCreatedInvitation =
    canManageCurrentWorkspace && createdInvitation?.workspaceId === serverSession?.workspace?.id ? createdInvitation : null;
  const localSnapshotSummary = useMemo(
    () => summarizeBudgetSnapshot(budget.currentBudgetSnapshot),
    [budget.currentBudgetSnapshot]
  );
  const serverSnapshotSummary = useMemo(
    () => (serverSnapshot ? summarizeBudgetSnapshot(hydrateWorkspaceSnapshot(serverSnapshot)) : null),
    [serverSnapshot]
  );
  const hasRemoteDecision =
    !!serverSnapshot &&
    (!isWorkspaceSnapshotEmpty(serverSnapshot) || hasLocalBudgetData(budget.currentBudgetSnapshot));
  const currentSnapshotKey = useMemo(
    () => buildSnapshotKey(budget.currentBudgetSnapshot),
    [budget.currentBudgetSnapshot]
  );
  const isServerSyncCurrent = !!lastSyncedSnapshotKey && currentSnapshotKey === lastSyncedSnapshotKey;
  const accountSyncState = getAccountSyncState({
    hasServerApi: !!serverApi,
    hasSession: !!serverSession,
    hasWorkspace: !!serverSession?.workspace,
    isBusy: auth.isServerBusy,
    isSnapshotChecked: isServerSnapshotChecked,
    hasServerSnapshot: hasRemoteDecision,
    hasAuthFailure: auth.serverErrorKind === "auth",
    hasError: auth.serverErrorKind !== null
  });
  const displayedSyncState: AccountSyncState =
    accountSyncState === "signed-in" && lastServerSyncedAt && isServerSyncCurrent ? "synced" : accountSyncState;
  const syncStateView = getSyncStateView(displayedSyncState);

  // Precomputed here (page used to inline these for the sync panel).
  const showUploadButton = Boolean(
    serverSnapshot && isWorkspaceSnapshotEmpty(serverSnapshot) && hasLocalBudgetData(budget.getCurrentBudgetSnapshot())
  );
  const showLoadButton = Boolean(serverSnapshot && !isWorkspaceSnapshotEmpty(serverSnapshot));

  // ── workspaces & sync decision ───────────────────────────────────────
  async function loadServerWorkspaces(session = serverSession) {
    if (!serverApi || !session) {
      setServerWorkspaces([]);
      return [];
    }

    const workspaces = await serverApi.listWorkspaces(session.token);
    setServerWorkspaces(workspaces);
    return workspaces;
  }

  async function prepareServerSyncDecision(session: ServerSession) {
    if (!serverApi) {
      setIsServerSnapshotChecked(false);
      return false;
    }

    setIsServerSnapshotChecked(false);
    setServerSnapshot(null);
    // 워크스페이스/세션이 바뀔 수 있는 진입점이므로 세대를 올려 이전 워크스페이스의
    // 진행 중 히스토리 응답을 무효화하고, 활성 scope 를 이 세션으로 맞춘다(이후
    // 이 세션의 refresh 만 커밋 가능). workspace 없으면 scope 는 null.
    coach.invalidateMonthlyReport(session);
    auth.setServerErrorKind(null);

    if (!session.workspace) {
      auth.setServerStatus("서버 계정은 연결됐지만 선택된 워크스페이스가 없습니다. 초대 수락 후 동기화를 사용할 수 있습니다.");
      return false;
    }

    try {
      const remoteSnapshot = await serverApi.getWorkspaceSnapshot(session.workspace.id, session.token);
      setServerSnapshot(remoteSnapshot);
      setIsServerSnapshotChecked(true);
      // 추세 조각용 히스토리를 백그라운드로 갱신(대기하지 않음 — 동기화 흐름 안 막음).
      void coach.refreshMonthlyReport(session);

      if (isWorkspaceSnapshotEmpty(remoteSnapshot) && hasLocalBudgetData(budget.getCurrentBudgetSnapshot())) {
        auth.setServerStatus("서버 워크스페이스가 비어 있습니다. 이 브라우저 데이터를 업로드할 수 있습니다.");
        return true;
      }

      if (!isWorkspaceSnapshotEmpty(remoteSnapshot)) {
        auth.setServerStatus("서버 데이터가 있습니다. 불러오거나 현재 브라우저 데이터로 동기화할 수 있습니다.");
        return true;
      }

      auth.setServerStatus("서버 워크스페이스와 연결되었습니다. 로컬 전용으로 계속해도 됩니다.");
      return true;
    } catch (error) {
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
    const nextSession = {
      ...serverSession,
      workspace
    };

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
    if (workspace) {
      await prepareServerSyncDecision(nextSession);
      await refreshSharing(nextSession);
    } else {
      auth.setServerStatus("사용 가능한 서버 워크스페이스가 없습니다.");
    }
  }

  async function handleSyncNow() {
    if (!serverApi || !serverSession?.workspace) {
      auth.setServerStatus("동기화할 서버 워크스페이스가 없습니다.");
      return;
    }

    if (!canUploadServerSnapshot) {
      auth.setServerStatus(isServerSnapshotChecked ? "보기 전용 권한은 서버에 업로드할 수 없습니다." : "서버 상태 확인이 끝난 뒤 업로드할 수 있습니다.");
      return;
    }

    auth.setIsServerBusy(true);
    try {
      // 마지막으로 읽은 서버 버전을 실어 보낸다. 서버가 이 값과 현재 DB 값을
      // 비교해 동시 편집 충돌(409)을 판정한다.
      const nextSnapshot = buildWorkspaceSnapshot(
        serverSession.workspace.id,
        budget.getCurrentBudgetSnapshot(),
        serverSnapshot?.syncVersion ?? 0
      );
      const savedSnapshot = await serverApi.putWorkspaceSnapshot(serverSession.workspace.id, nextSnapshot, serverSession.token);
      setServerSnapshot(savedSnapshot);
      setLastServerSyncedAt(new Date());
      setLastSyncedSnapshotKey(buildSnapshotKey(hydrateWorkspaceSnapshot(savedSnapshot)));
      auth.setServerErrorKind(null);
      auth.setServerStatus("현재 브라우저 데이터를 서버에 동기화했습니다.");
      // 방금 업로드가 새 히스토리 엔트리가 되므로 추세를 다시 계산해 둔다.
      // (업로드 await 중 전환이 있었다면 serverSession 의 scope 가 활성 scope 와
      //  달라 refreshMonthlyReport 가 커밋 단계에서 스스로 폐기한다.)
      void coach.refreshMonthlyReport(serverSession);
    } catch (error) {
      // 충돌(409): 다른 기기/멤버가 먼저 저장함. 서버 최신본을 다시 받아와
      // serverSnapshot 을 갱신하고, 사용자에게 다시 불러온 뒤 동기화하도록 안내.
      if (error instanceof ServerApiError && error.status === 409) {
        try {
          const latest = await serverApi.getWorkspaceSnapshot(serverSession.workspace.id, serverSession.token);
          setServerSnapshot(latest);
        } catch {
          // 최신본 재조회 실패는 무시 — 아래 충돌 안내는 그대로 표시한다.
        }
        auth.setServerErrorKind("request");
        auth.setServerStatus("다른 기기나 멤버가 먼저 저장해 충돌이 났습니다. 서버 데이터를 다시 불러온 뒤 동기화하세요. 로컬 저장은 계속 유지됩니다.");
        return;
      }
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error) + " 로컬 저장은 계속 유지됩니다.");
    } finally {
      auth.setIsServerBusy(false);
    }
  }

  async function handleLoadServerSnapshot() {
    if (!serverApi || !serverSession?.workspace) {
      auth.setServerStatus("불러올 서버 워크스페이스가 없습니다.");
      return;
    }

    auth.setIsServerBusy(true);
    try {
      const nextSnapshot = serverSnapshot ?? (await serverApi.getWorkspaceSnapshot(serverSession.workspace.id, serverSession.token));
      budget.applyBudgetSnapshot(hydrateWorkspaceSnapshot(nextSnapshot));
      setServerSnapshot(nextSnapshot);
      setLastServerSyncedAt(new Date());
      setLastSyncedSnapshotKey(buildSnapshotKey(hydrateWorkspaceSnapshot(nextSnapshot)));
      auth.setServerErrorKind(null);
      auth.setServerStatus("서버 데이터를 이 브라우저에 불러왔습니다.");
      // 복원 직후에도 히스토리 기반 추세를 채워 코치 입력에 반영한다.
      void coach.refreshMonthlyReport(serverSession);
    } catch (error) {
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error) + " 로컬 데이터는 변경하지 않았습니다.");
    } finally {
      auth.setIsServerBusy(false);
    }
  }

  function handleStayLocalOnly() {
    auth.setServerStatus("로컬 전용으로 계속합니다. 서버 연결은 유지되지만 데이터를 덮어쓰지 않습니다.");
  }

  // ── server-logout / auth-failure teardown (called from useServerAuth) ──
  function resetOnServerLogout() {
    // 진행 중인 히스토리 응답을 무효화하고 이전 사용자 추세를 즉시 비운다.
    setServerSnapshot(null);
    coach.invalidateMonthlyReport();
    setIsServerSnapshotChecked(false);
    setServerWorkspaces([]);
    setMembers([]);
    setInvitations([]);
    setSentInvitations([]);
    setLastServerSyncedAt(null);
    setLastSyncedSnapshotKey("");
    clearWorkspaceScopedSharingDrafts();
  }

  // Session invalidated while restoring (refresh token dead too): clears less
  // than a full logout — exactly the original page-level sequence.
  function dropSessionOnAuthFailure() {
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
    const isOwner = session.workspace?.role === "owner";

    try {
      const [nextMembers, nextInvitations, nextSentInvitations] = await Promise.all([
        session.workspace ? serverApi.listMembers(session.workspace.id, session.token) : Promise.resolve([]),
        serverApi.listInvitations(session.token),
        session.workspace && isOwner
          ? serverApi.listWorkspaceInvitations(session.workspace.id, session.token)
          : Promise.resolve([])
      ]);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
      setSentInvitations(nextSentInvitations);
      auth.setServerErrorKind(null);
    } catch (error) {
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    }
  }

  async function handleCreateInvitation() {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    auth.setIsServerBusy(true);
    try {
      const invitation = await serverApi.createInvitation(serverSession.workspace.id, { email: inviteEmail, role: inviteRole }, serverSession.token);
      setCreatedInvitation(invitation);
      setInviteEmail("");
      auth.setServerStatus("초대를 만들었습니다. 아래 토큰을 초대받은 사용자에게 전달하세요.");
      auth.setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      auth.setIsServerBusy(false);
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

    auth.setIsServerBusy(true);
    try {
      const accepted = await serverApi.acceptInvitation(invitationId, tokenValue, serverSession.token);
      const nextSession = await auth.resolveAndStoreServerSession({ ...serverSession, workspace: accepted.workspace });
      clearWorkspaceScopedSharingDrafts();
      auth.setServerStatus("초대를 수락했습니다. 새 워크스페이스가 선택되었습니다.");
      auth.setServerErrorKind(null);
      await prepareServerSyncDecision(nextSession);
      await refreshSharing(nextSession);
    } catch (error) {
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      auth.setIsServerBusy(false);
    }
  }

  async function handleUpdateMemberRole(memberId: string, role: WorkspaceMemberDto["role"]) {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    auth.setIsServerBusy(true);
    try {
      await serverApi.updateMemberRole(serverSession.workspace.id, memberId, role, serverSession.token);
      auth.setServerStatus("멤버 권한을 변경했습니다.");
      auth.setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      auth.setIsServerBusy(false);
    }
  }

  async function handleDeleteMember(memberId: string) {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    if (!window.confirm("이 멤버를 워크스페이스에서 제거할까요?")) {
      return;
    }

    auth.setIsServerBusy(true);
    try {
      await serverApi.deleteMember(serverSession.workspace.id, memberId, serverSession.token);
      auth.setServerStatus("멤버를 제거했습니다.");
      auth.setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      auth.setIsServerBusy(false);
    }
  }

  async function handleRevokeInvitation(invitationId: string) {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    if (!window.confirm("이 초대를 취소할까요? 취소된 초대 링크는 더 이상 사용할 수 없습니다.")) {
      return;
    }

    auth.setIsServerBusy(true);
    try {
      await serverApi.revokeInvitation(serverSession.workspace.id, invitationId, serverSession.token);
      auth.setServerStatus("초대를 취소했습니다.");
      auth.setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      auth.setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      auth.setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      auth.setIsServerBusy(false);
    }
  }

  function clearWorkspaceScopedSharingDrafts() {
    setCreatedInvitation(null);
    setInviteEmail("");
    setInviteRole("viewer");
    setAcceptTokens({});
  }

  return {
    serverSnapshot,
    setIsServerSnapshotChecked,
    isServerSnapshotChecked,
    lastServerSyncedAt,
    serverWorkspaces,
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
