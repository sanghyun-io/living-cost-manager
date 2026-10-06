"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Text } from "@mantine/core";
import { COACH_MODEL_APPROX_MB, isWebGpuAvailable } from "./lib/coachModel";
import { track } from "./lib/analytics";
import { renewalQueue } from "./lib/costViews";
import { getMonthlyEquivalentAmount } from "./lib/budget";
import { AppHeader } from "./components/AppHeader";
import { useMarketingConsent } from "./lib/useMarketingConsent";
import { HeroPanel } from "./components/HeroPanel";
import { MetricGrid } from "./components/MetricGrid";
import { InsightsPanel } from "./components/InsightsPanel";
import { ChartSection } from "./components/ChartSection";
import { FixedCostTable } from "./components/FixedCostTable";
import { CategoryModal } from "./components/modals/CategoryModal";
import { CardModal } from "./components/modals/CardModal";
import { AuthModal } from "./components/modals/AuthModal";
import { ResetPasswordModal } from "./components/modals/ResetPasswordModal";
import { VerifyEmailNoticeModal } from "./components/modals/VerifyEmailNoticeModal";
import { CoachModal } from "./components/modals/CoachModal";
import { DataModal } from "./components/modals/DataModal";
import { DeleteAccountModal } from "./components/modals/DeleteAccountModal";
import { useUIState } from "./lib/useUIState";
import { useServerAuth } from "./lib/useServerAuth";
import { useLocalUsers } from "./lib/useLocalUsers";
import { useBudgetData } from "./lib/useBudgetData";
import { useCoach } from "./lib/useCoach";
import { useWorkspaceSync } from "./lib/useWorkspaceSync";
import type { BudgetDataApi } from "./lib/useBudgetData";
import type { LocalUsersApi } from "./lib/useLocalUsers";
import type { WorkspaceSyncApi } from "./lib/useWorkspaceSync";

export default function Home() {
  // Hook creation order respects render-time data flow:
  //   ui → auth → users → budget → coach → sync
  // The two async back-edges (auth → users/sync) go through latest-value refs
  // below — their handlers only run from events/post-boot effects.
  const ui = useUIState();
  const marketingConsent = useMarketingConsent();
  const usersRef = useRef<LocalUsersApi | null>(null);
  const budgetRef = useRef<BudgetDataApi | null>(null);
  const syncRef = useRef<WorkspaceSyncApi | null>(null);

  const auth = useServerAuth({
    ui,
    getUsers: () => usersRef.current as LocalUsersApi,
    getSync: () => syncRef.current as WorkspaceSyncApi
  });
  const users = useLocalUsers({
    ui,
    auth,
    getBudget: () => (budgetRef.current as BudgetDataApi).getCurrentBudgetSnapshot()
  });
  const budget = useBudgetData({ users, ui, marketingPersonal: !auth.serverSession && !users.currentUser?.serverUserId });
  const coach = useCoach({ budget, serverApi: auth.serverApi });
  const sync = useWorkspaceSync({ ui, auth, budget, coach, localUserId: users.currentUser?.id ?? null,
    isLocalDataReady: !!budget.localScopeKey && !budget.saveError && !users.isSampleMode });
  const [reviewDate, setReviewDate] = useState(() => new Date().toDateString());
  useEffect(() => {
    const refresh = () => setReviewDate(new Date().toDateString());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const reviewItems = useMemo(() => renewalQueue(budget.fixedCosts, new Date(reviewDate)), [budget.fixedCosts, reviewDate]);

  usersRef.current = users;
  budgetRef.current = budget;
  syncRef.current = sync;

  useEffect(() => {
    if (auth.serverSession && budget.localScopeKey && !users.isSampleMode) {
      void syncRef.current?.prepareServerSyncDecision(auth.serverSession);
      void syncRef.current?.loadServerWorkspaces(auth.serverSession).catch(() => undefined);
    }
  }, [auth.serverSession?.user.id, auth.serverSession?.workspace?.id, budget.localScopeKey, users.isSampleMode]);

  // Service worker: production-only, registered after load (see note inside).
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return;
    }

    const registerWorker = () => {
      void navigator.serviceWorker.register("./sw.js").catch(() => undefined);
    };

    // useEffect 는 보통 load 이벤트 이후 실행되므로, 이미 로드가 끝났으면
    // load 리스너만 걸 경우 영영 등록되지 않는다. readyState 로 분기한다.
    if (document.readyState === "complete") {
      registerWorker();
      return;
    }

    window.addEventListener("load", registerWorker);
    return () => window.removeEventListener("load", registerWorker);
  }, []);

  // 온디바이스 애널리틱스: 화면 방문 (mount 1회, IndexedDB 로컬 저장만).
  useEffect(() => {
    track({ type: "app.page_view", timestamp: Date.now(), data: { path: window.location.pathname } });
  }, []);

  // 내보내기/공유 핸들러의 애널리틱스 래퍼. 클릭 1회 = 이벤트 1건 (백업
  // 내보내기 버튼은 두 곳에 노출되지만 같은 래퍼를 거쳐 중복 없다).
  function handleExportCsv() {
    track({ type: "export.csv", timestamp: Date.now(), data: {} });
    budget.handleExportTemplate();
  }

  function handleExportBackupWithTracking() {
    track({ type: "export.backup", timestamp: Date.now(), data: {} });
    budget.handleExportBackup();
  }

  function handleCreateInvitationWithTracking() {
    track({ type: "share.invite", timestamp: Date.now(), data: { role: sync.inviteRole } });
    void sync.handleCreateInvitation();
  }

  function handleAcceptInvitationWithTracking(invitationId: string) {
    track({ type: "share.accept", timestamp: Date.now(), data: {} });
    void sync.handleAcceptInvitation(invitationId);
  }

  if (!users.isBootLoaded || !users.isLoaded) {
    return (
      <main className="page-shell">
        <section className="login-card">
          <p className="section-label">생활비 관리자</p>
          <h1>불러오는 중입니다</h1>
        </section>
      </main>
    );
  }

  return (
    <>
      <a className="skip-link" href="#fixed-costs">고정비 편집으로 건너뛰기</a>
      <AppHeader
        saveError={budget.saveError}
        onRetrySave={budget.retrySave}
        onExportUnsaved={budget.handleExportBackup}
        recoveryRequired={budget.localRecoveryRequired}
        lastSavedAt={budget.lastSavedAt}
        serverSession={auth.serverSession}
        currentUserName={users.currentUser?.name}
        onOpenData={() => ui.setIsDataModalOpen(true)}
        onOpenAuth={() => ui.setIsAuthModalOpen(true)}
        onOpenCoach={coach.openCoachModal}
        onServerLogout={() => {
          auth.handleServerLogout();
          users.handleLogout();
        }}
      />
      <main className="page-shell">
      <HeroPanel
        monthlyIncome={budget.monthlyIncome}
        expenseRate={budget.summary.expenseRate}
        hasServerWorkspace={Boolean(auth.serverSession?.workspace)}
        onIncomeChange={budget.handleIncomeChange}
      />

      <section className="workspace-note" aria-label="시작 방식">
        <Text size="sm">{users.isSampleMode ? "샘플 체험 중 · 내 데이터와 분리된 예시입니다." : "내 데이터 · 기준 납부일을 입력하면 다음 30일 예정액을 확인할 수 있습니다."}</Text>
        <Button variant="default" size="xs" onClick={() => users.handleChooseDataMode(users.isSampleMode ? "blank" : "sample")}>
          {users.isSampleMode ? "내 데이터로 시작 / 돌아가기" : "분리된 샘플 체험"}
        </Button>
        <Text size="xs" c="dimmed">공간 전환 시 서버 연결을 해제합니다. 기존 내 데이터는 보존됩니다.</Text>
        <Button variant="subtle" color={budget.localRecoveryRequired ? "rose" : "gray"} size="xs" onClick={budget.handleExportRecovery}>{budget.localRecoveryRequired ? "저장 원본 내보내기" : "최근 교체 전 복구본 내보내기"}</Button>
      </section>

      <InsightsPanel fixedCosts={budget.fixedCosts} monthlyIncome={budget.monthlyIncome} monthlyExpense={budget.summary.monthlyExpense} />

      <section className="workspace" id="fixed-costs" tabIndex={-1} aria-label="고정비 편집">
        <section className="renewal-queue" aria-label="갱신 검토 작업목록">
          <Text fw={700}>갱신 검토 작업목록</Text>
          <Text size="sm" c="dimmed">오늘부터 30일간 미검토 · 해지 예정 · 변경 검토. 예정 절감은 실제 절감이 아닙니다.</Text>
          {reviewItems.length === 0 ? <Text size="sm">현재 검토할 작업이 없습니다.</Text> : null}
          {reviewItems.map((item) => <Button key={item.id} variant="light" m={4} onClick={() => budget.revealItem(item.id)}>
            {item.name} · {item.renewalStatus === "cancel-planned" ? "해지 예정" : item.renewalStatus === "change-review" ? "변경 검토" : "임박 미검토"} 편집
          </Button>)}
        </section>
        {budget.canUndoDelete ? <Button variant="light" onClick={budget.handleUndoDelete}>최근 삭제 취소</Button> : null}
        <FixedCostTable
          focusItemId={budget.focusItemId}
          focusRequest={budget.focusRequest}
          costFilters={budget.costFilters}
          onCostFilters={budget.setCostFilters}
          onResetFilters={budget.resetCostFilters}
          categories={budget.categories}
          cards={budget.cards}
          visibleFixedCosts={budget.visibleFixedCosts}
          visibleFixedCostTotal={budget.visibleFixedCostTotal}
          categoryFilterId={ui.categoryFilterId}
          isDeleteMode={ui.isDeleteMode}
          selectedDeleteIds={ui.selectedDeleteIds}
          importMessage={ui.importMessage}
          onItemChange={budget.handleItemChange}
          onPaymentMethodChange={budget.handlePaymentMethodChange}
          onPaymentOptionChange={budget.handlePaymentOptionChange}
          onAddItem={budget.handleAddItem}
          onDuplicateItem={budget.handleDuplicateItem}
          onQuickAdd={budget.handleQuickAdd}
          onEnterDeleteMode={budget.handleEnterDeleteMode}
          onCancelDeleteMode={budget.handleCancelDeleteMode}
          onConfirmDeleteItems={budget.handleConfirmDeleteItems}
          onToggleDeleteSelection={budget.handleToggleDeleteSelection}
          onFilterChange={ui.handleFilterChange}
          onOpenCategory={() => ui.setIsCategoryModalOpen(true)}
          onOpenCard={() => ui.setIsCardModalOpen(true)}
          onOpenData={() => ui.setIsDataModalOpen(true)}
        />

        <MetricGrid summary={budget.summary} fixedCostCount={budget.fixedCosts.length} />
        <ChartSection
          chartMode={ui.chartMode}
          buckets={budget.buckets}
          pieSegments={budget.pieSegments}
          monthlyExpense={budget.summary.monthlyExpense}
          pieBackground={budget.pieBackground}
          activePieSegment={ui.activePieSegment}
          pieTooltipPosition={ui.pieTooltipPosition}
          onChartModeChange={ui.setChartMode}
          onPieMove={(event) => ui.handlePieMove(event, budget.pieSegments)}
          onPieLeave={() => ui.setActivePieSegment(null)}
        />
      </section>

      <DataModal
           marketingConsent={marketingConsent}
          importMessage={ui.importMessage}
          importPreview={budget.pendingImport ? { currentCount: budget.fixedCosts.length, targetCount: budget.pendingImport.snapshot.fixedCosts.length,
            currentAmount: budget.summary.monthlyExpense, targetAmount: budget.pendingImport.snapshot.fixedCosts.reduce((sum, item) => sum + getMonthlyEquivalentAmount(item), 0) } : null}
          onApplyImport={budget.applyImport}
          onCancelImport={budget.cancelImport}
          opened={ui.isDataModalOpen}
          hasServerApi={Boolean(auth.serverApi)}
          importFileRef={budget.importFileRef}
          backupFileRef={budget.backupFileRef}
          onClose={() => { budget.cancelImport(); ui.setIsDataModalOpen(false); }}
          onExportTemplate={handleExportCsv}
          onImportTemplate={(file) => void budget.handleImportTemplate(file)}
          onExportBackup={handleExportBackupWithTracking}
          onImportBackup={(file) => void budget.handleImportBackup(file)}
          sync={{
            autoSyncEnabled: sync.autoSyncEnabled,
            canEnableAutoSync: sync.canEnableAutoSync,
            onAutoSyncChange: sync.setAutoSyncEnabled,
            serverSession: auth.serverSession,
            syncStateView: sync.syncStateView,
            displayedSyncState: sync.displayedSyncState,
            lastServerSyncedAt: sync.lastServerSyncedAt,
            localSnapshotSummary: sync.localSnapshotSummary,
            serverSnapshotSummary: sync.serverSnapshotSummary,
            serverSnapshot: sync.serverSnapshot,
            serverWorkspaces: sync.serverWorkspaces,
            currentWorkspaceRole: sync.currentWorkspaceRole,
            canUploadServerSnapshot: sync.canUploadServerSnapshot,
            isServerBusy: auth.isServerBusy,
            serverStatus: auth.serverStatus,
            serverErrorKind: auth.serverErrorKind,
            changeCurrentPassword: auth.changeCurrentPassword,
            changeNewPassword: auth.changeNewPassword,
            showUploadButton: sync.showUploadButton,
            showLoadButton: sync.showLoadButton,
            onServerLogout: auth.handleServerLogout,
            onResendVerification: () => void auth.handleResendVerification(),
            onChangePassword: () => void auth.handleChangePassword(),
            onChangeCurrentPassword: auth.setChangeCurrentPassword,
            onChangeNewPassword: auth.setChangeNewPassword,
            onSelectWorkspace: (workspaceId) => void sync.handleSelectServerWorkspace(workspaceId),
            onCheckServer: () => {
              if (auth.serverSession) {
                void sync.prepareServerSyncDecision(auth.serverSession);
              }
            },
            onSyncNow: () => void sync.handleSyncNow(),
            onLoadSnapshot: () => void sync.handleLoadServerSnapshot(),
            onStayLocal: sync.handleStayLocalOnly,
            onOpenAuth: () => {
              ui.setIsDataModalOpen(false);
              ui.setIsAuthModalOpen(true);
            },
            onOpenDeleteAccount: () => ui.setIsDeleteAccountModalOpen(true),
            onExportBackup: handleExportBackupWithTracking
          }}
          sharing={{
            serverSession: auth.serverSession,
            members: sync.members,
            invitations: sync.invitations,
            sentInvitations: sync.sentInvitations,
            acceptTokens: sync.acceptTokens,
            inviteEmail: sync.inviteEmail,
            inviteRole: sync.inviteRole,
            visibleCreatedInvitation: sync.visibleCreatedInvitation,
            canManageCurrentWorkspace: sync.canManageCurrentWorkspace,
            isServerBusy: auth.isServerBusy,
            onAcceptTokenChange: (invitationId, value) =>
              sync.setAcceptTokens((tokens) => ({ ...tokens, [invitationId]: value })),
            onAcceptInvitation: handleAcceptInvitationWithTracking,
            onRefreshSharing: () => void sync.refreshSharing(),
            onCreateInvitation: handleCreateInvitationWithTracking,
            onInviteEmailChange: sync.setInviteEmail,
            onInviteRoleChange: sync.setInviteRole,
            onUpdateMemberRole: (memberId, role) => void sync.handleUpdateMemberRole(memberId, role),
            onDeleteMember: (memberId) => void sync.handleDeleteMember(memberId),
            onRevokeInvitation: (invitationId) => void sync.handleRevokeInvitation(invitationId)
          }}
        />

      <DeleteAccountModal
        opened={ui.isDeleteAccountModalOpen}
        email={auth.serverSession?.user.email ?? ""}
        hasSharedWorkspaces={sync.serverWorkspaces.some((workspace) => workspace.role !== "owner")}
        isBusy={auth.isServerBusy}
        statusMessage={auth.serverStatus}
        statusError={auth.serverErrorKind !== null}
        onConfirm={auth.handleDeleteAccount}
        onClose={() => ui.setIsDeleteAccountModalOpen(false)}
      />

      <AuthModal
          opened={ui.isAuthModalOpen}
          hasServerApi={Boolean(auth.serverApi)}
          initialSession={auth.bootServerSession}
          isServerBusy={auth.isServerBusy}
          serverStatus={auth.serverStatus}
          serverErrorKind={auth.serverErrorKind}
          loginRequest={auth.authLoginRequest}
          onSubmit={auth.handleServerAuthSubmit}
          onForgotSubmit={(email) => void auth.handleForgotPassword(email)}
          onViewChange={(view) => {
            if (view === "forgot") {
              auth.setServerStatus("");
            }
          }}
          onClose={() => ui.setIsAuthModalOpen(false)}
        />

      <ResetPasswordModal
          opened={auth.resetToken !== null}
          isServerBusy={auth.isServerBusy}
          serverStatus={auth.serverStatus}
          serverErrorKind={auth.serverErrorKind}
          onSubmit={auth.handleResetPassword}
          onClose={auth.closeResetModal}
        />

      <VerifyEmailNoticeModal
          opened={auth.verifyNoticeEmail !== null}
          email={auth.verifyNoticeEmail ?? ""}
          isServerBusy={auth.isServerBusy}
          serverStatus={auth.serverStatus}
          serverErrorKind={auth.serverErrorKind}
          onResend={() => void auth.handleResendVerification()}
          onContinue={() => {
            auth.setVerifyNoticeEmail(null);
            auth.setServerStatus("");
            auth.setServerErrorKind(null);
            ui.setIsDataModalOpen(true);
          }}
          onClose={() => {
            auth.setVerifyNoticeEmail(null);
            auth.setServerStatus("");
            auth.setServerErrorKind(null);
          }}
        />

      <CoachModal
          opened={coach.isCoachModalOpen}
          webGpuAvailable={isWebGpuAvailable()}
          hasData={coach.coachHasData}
          approxMb={COACH_MODEL_APPROX_MB}
          status={coach.coachStatus}
          loadProgress={coach.coachProgress}
          loadText={coach.coachProgressText}
          coaching={coach.coachingText}
          errorMessage={coach.coachError}
          fallbackHeadline={coach.coachFallbackHeadline}
          onStart={() => void coach.runCoaching()}
          onRegenerate={() => void coach.runCoaching()}
          onClose={() => coach.setIsCoachModalOpen(false)}
        />

      <CategoryModal
          opened={ui.isCategoryModalOpen}
          categories={budget.categories}
          onAdd={budget.handleAddCategory}
          onRename={budget.handleRenameCategory}
          onDelete={budget.handleDeleteCategory}
          onClose={() => ui.setIsCategoryModalOpen(false)}
        />

      <CardModal
          opened={ui.isCardModalOpen}
          cards={budget.cards}
          onAdd={budget.handleAddCard}
          onRename={budget.handleRenameCard}
          onUpdateBillingDay={budget.handleUpdateCardBillingDay}
          onUpdateEndOfMonth={budget.handleUpdateCardEndOfMonth}
          onDelete={budget.handleDeleteCard}
          onClose={() => ui.setIsCardModalOpen(false)}
        />
    </main>
    </>
  );
}
