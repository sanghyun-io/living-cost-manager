"use client";

import { useEffect, useRef } from "react";
import { COACH_MODEL_APPROX_MB, isWebGpuAvailable } from "./lib/coachModel";
import { AppHeader } from "./components/AppHeader";
import { HeroPanel } from "./components/HeroPanel";
import { MetricGrid } from "./components/MetricGrid";
import { ChartSection } from "./components/ChartSection";
import { FixedCostTable } from "./components/FixedCostTable";
import { CategoryModal } from "./components/modals/CategoryModal";
import { CardModal } from "./components/modals/CardModal";
import { AuthModal } from "./components/modals/AuthModal";
import { ResetPasswordModal } from "./components/modals/ResetPasswordModal";
import { VerifyEmailNoticeModal } from "./components/modals/VerifyEmailNoticeModal";
import { CoachModal } from "./components/modals/CoachModal";
import { DataModal } from "./components/modals/DataModal";
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
  const budget = useBudgetData({ users, ui });
  const coach = useCoach({ budget, serverApi: auth.serverApi });
  const sync = useWorkspaceSync({ ui, auth, budget, coach });

  usersRef.current = users;
  budgetRef.current = budget;
  syncRef.current = sync;

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
    <main className="page-shell">
      <AppHeader
        saveError={budget.saveError}
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
      <HeroPanel
        monthlyIncome={budget.monthlyIncome}
        expenseRate={budget.summary.expenseRate}
        hasServerWorkspace={Boolean(auth.serverSession?.workspace)}
        onIncomeChange={budget.handleIncomeChange}
      />

      <MetricGrid summary={budget.summary} fixedCostCount={budget.fixedCosts.length} />

      <section className="workspace">
        <FixedCostTable
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
          opened={ui.isDataModalOpen}
          hasServerApi={Boolean(auth.serverApi)}
          importFileRef={budget.importFileRef}
          backupFileRef={budget.backupFileRef}
          onClose={() => ui.setIsDataModalOpen(false)}
          onExportTemplate={budget.handleExportTemplate}
          onImportTemplate={(file) => void budget.handleImportTemplate(file)}
          onExportBackup={budget.handleExportBackup}
          onImportBackup={(file) => void budget.handleImportBackup(file)}
          sync={{
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
            onExportBackup: budget.handleExportBackup
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
            onAcceptInvitation: (invitationId) => void sync.handleAcceptInvitation(invitationId),
            onRefreshSharing: () => void sync.refreshSharing(),
            onCreateInvitation: () => void sync.handleCreateInvitation(),
            onInviteEmailChange: sync.setInviteEmail,
            onInviteRoleChange: sync.setInviteRole,
            onUpdateMemberRole: (memberId, role) => void sync.handleUpdateMemberRole(memberId, role),
            onDeleteMember: (memberId) => void sync.handleDeleteMember(memberId),
            onRevokeInvitation: (invitationId) => void sync.handleRevokeInvitation(invitationId)
          }}
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
  );
}
