"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Text } from "@mantine/core";
import { COACH_MODEL_APPROX_MB, isWebGpuAvailable } from "./lib/coachModel";
import { track } from "./lib/analytics";
import { renewalQueue } from "./lib/costViews";
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
import { TemplateModal } from "./components/modals/TemplateModal";
import { useUIState } from "./lib/useUIState";
import { useServerAuth } from "./lib/useServerAuth";
import { useLocalUsers } from "./lib/useLocalUsers";
import { useBudgetData } from "./lib/useBudgetData";
import { useCoach } from "./lib/useCoach";
import { useWorkspaceSync } from "./lib/useWorkspaceSync";
import type { BudgetDataApi } from "./lib/useBudgetData";
import type { LocalUsersApi } from "./lib/useLocalUsers";
import type { WorkspaceSyncApi } from "./lib/useWorkspaceSync";
import { useLedgers } from './lib/useLedgers';
import { LedgerControls } from './components/LedgerControls';
import { LedgerSummary } from './components/LedgerSummary';

export default function Home() {
  // Hook creation order respects render-time data flow:
  //   ui → auth → users → budget → coach → sync
  // The two async back-edges (auth → users/sync) go through latest-value refs
  // below — their handlers only run from events/post-boot effects.
  const ui = useUIState();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateError, setTemplateError] = useState("");
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
    saveBeforeSwitch: () => budgetRef.current?.saveBeforeSwitch() ?? false,
    getBudget: () => (budgetRef.current as BudgetDataApi).getCurrentBudgetSnapshot()
  });
  const budget = useBudgetData({ users, ui, session: auth.serverSession, marketingPersonal: !auth.serverSession && !users.currentUser?.serverUserId });
  const coach = useCoach({ budget, serverApi: auth.serverApi });
  const sync = useWorkspaceSync({ ui, auth, budget, coach, localUserId: budget.localScopeKey,
    isLocalDataReady: !!budget.localScopeKey && !budget.saveError && !users.isSampleMode });
  const ledgers = useLedgers(auth, sync);
  const viewer = !users.isSampleMode && sync.currentWorkspaceRole === 'viewer';
  const canEdit = !viewer && !ledgers.aggregateMode && !!budget.localScopeKey;
  const syncAvailable = !!budget.localScopeKey && !budget.saveError && !users.isSampleMode && !ledgers.mutationPending;
  const [reviewDate, setReviewDate] = useState(() => new Date().toDateString());
  const [referenceInstant, setReferenceInstant] = useState(() => new Date());
  useEffect(() => {
    const refresh = () => { setReviewDate(new Date().toDateString()); setReferenceInstant(new Date()); };
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
  function handleExitAccount() {
    try {
      if (!budget.saveBeforeSwitch() || !users.handleLogout()) return;
      auth.handleServerLogout(); setTemplatesOpen(false);
    } catch { setTemplateError('가계부를 안전하게 저장하지 못해 로그아웃하지 않았습니다. 현재 내용을 백업하세요.'); }
  }

  if (!users.isBootLoaded || !users.isLoaded || (!budget.localScopeKey && !budget.saveError)) {
    return (
      <main className="page-shell">
      {templateError ? <Text role="alert" c="rose" mt="md">{templateError}</Text> : null}
        <section className="login-card">
          <p className="section-label">생활비 관리자</p>
          <h1>불러오는 중입니다</h1>
          {budget.saveError ? <><Text role="alert">{budget.saveError}</Text><Button onClick={budget.handleExportBackup}>현재 메모리 데이터 백업</Button></> : null}
        </section>
      </main>
    );
  }

  return (
    <>
      <a className="skip-link" href={ledgers.aggregateMode ? '#aggregate-result' : '#fixed-costs'}>{ledgers.aggregateMode ? '합산 결과로 건너뛰기' : '고정비 편집으로 건너뛰기'}</a>
      <AppHeader
        ledgerControls={auth.serverSession ? <LedgerControls key={auth.serverSession.user.id + ':' + auth.serverSession.workspace?.id} session={auth.serverSession} workspaces={sync.serverWorkspaces} onSwitch={id => void sync.handleSelectServerWorkspace(id)} ledgers={ledgers} canSwitch={!!budget.localScopeKey && !budget.saveError && !users.isSampleMode} /> : null}
        saveError={budget.saveError}
        onRetrySave={budget.retrySave}
        onExportUnsaved={budget.handleExportBackup}
        recoveryRequired={budget.localRecoveryRequired}
        lastSavedAt={budget.lastSavedAt}
        serverSession={auth.serverSession}
        currentUserName={budget.profileName}
        onOpenData={() => ui.setIsDataModalOpen(true)}
        onOpenAuth={() => ui.setIsAuthModalOpen(true)}
        onOpenCoach={coach.openCoachModal}
        onOpenTemplates={() => { setTemplateError(""); setTemplatesOpen(true); }}
        onServerLogout={handleExitAccount}
      />
      <main className="page-shell">
      {templateError ? <Text role="alert" aria-live="assertive" c="rose" mb="md">{templateError}</Text> : null}
      {users.templateReturnId ? <div className="workspace-note"><Text size="sm">템플릿으로 만든 새 공간입니다. 기존 데이터는 보존되어 있습니다.</Text><Button variant="default" onClick={() => setTemplateError(users.returnFromTemplate() ?? "")}>템플릿 적용 전 공간으로 돌아가기</Button></div> : null}
      {ledgers.aggregateMode ? <section id="aggregate-result" tabIndex={-1} aria-label="합산 보기">{ledgers.aggregate ? <LedgerSummary summary={ledgers.aggregate.totals} fromDate={ledgers.aggregate.fromDate} untilDateExclusive={ledgers.aggregate.untilDateExclusive} aggregate /> : <Text role="status">합산할 가계부를 선택하고 조회하세요. 자동으로 전체 가계부를 선택하지 않습니다.</Text>}</section> : <>
      {viewer ? <Text role="status">보기 전용 가계부입니다. 편집과 업로드는 할 수 없습니다.</Text> : null}
      <fieldset disabled={!canEdit} className="ledger-edit-region">
      <HeroPanel
        // Individual editing is never mounted as aggregate data.
        monthlyIncome={budget.monthlyIncome}
        expenseRate={budget.summary.expenseRate}
        hasServerWorkspace={Boolean(auth.serverSession?.workspace)}
        onIncomeChange={budget.handleIncomeChange}
      />
      </fieldset>

      <section className="workspace-note" aria-label="시작 방식">
        <Text size="sm">{users.isSampleMode ? "샘플 체험 중 · 내 데이터와 분리된 예시입니다." : "내 데이터 · 기준 납부일을 입력하면 다음 30일 예정액을 확인할 수 있습니다."}</Text>
        <Button variant="default" size="xs" onClick={() => void users.handleChooseDataMode(users.isSampleMode ? "blank" : "sample").catch(() => setTemplateError('가계부 저장에 실패하여 샘플 전환을 중단했습니다. 현재 내용을 백업하세요.'))}>
          {users.isSampleMode ? "내 데이터로 시작 / 돌아가기" : "분리된 샘플 체험"}
        </Button>
        <Text size="xs" c="dimmed">샘플은 별도 게스트 예시이며 서버로 업로드하지 않습니다. 돌아갈 때 계정과 가계부 권한을 다시 확인합니다.</Text>
        <Button variant="subtle" color={budget.localRecoveryRequired ? "rose" : "gray"} size="xs" onClick={budget.handleExportRecovery}>{budget.localRecoveryRequired ? "저장 원본 내보내기" : "최근 교체 전 복구본 내보내기"}</Button>
        {auth.serverSession && !users.isSampleMode ? <Button variant="subtle" color="gray" size="xs" onClick={budget.handleExportLegacySource}>이전 단일 가계부 원본(JSON) 내보내기</Button> : null}
      </section>

      <div className="dashboard-overview">
        <MetricGrid summary={budget.summary} fixedCostCount={budget.fixedCosts.length} />
        <InsightsPanel asOf={referenceInstant} fixedCosts={budget.fixedCosts} monthlyIncome={budget.monthlyIncome} monthlyExpense={budget.summary.monthlyExpense} />
      </div>

      <fieldset disabled={!canEdit} className="ledger-edit-region">
      <section className="workspace" id="fixed-costs" tabIndex={-1} aria-label="고정비 편집">
        <section className="renewal-queue" aria-label="갱신 검토 작업목록">
          <Text fw={700}>갱신 검토 작업목록</Text>
          <Text size="sm" c="dimmed">오늘부터 30일간 미검토 · 해지 예정 · 변경 검토. 예정 절감은 실제 절감이 아닙니다.</Text>
          {reviewItems.length === 0 ? <Text size="sm">현재 검토할 작업이 없습니다.</Text> : null}
          <div className="renewal-actions">
          {reviewItems.map((item) => <Button key={item.id} variant="subtle" onClick={() => budget.revealItem(item.id)}>
            {item.name} · {item.renewalStatus === "cancel-planned" ? "해지 예정" : item.renewalStatus === "change-review" ? "변경 검토" : "임박 미검토"} 편집
          </Button>)}
          </div>
        </section>
        {budget.canUndoDelete ? <Button variant="light" onClick={budget.handleUndoDelete}>최근 삭제 취소</Button> : null}
        <FixedCostTable
          key={budget.localScopeKey}
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

        {budget.summary.monthlyExpense > 0 ? <ChartSection
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
        /> : null}
      </section>

      </fieldset></>}
      <TemplateModal key={auth.serverSession ? auth.serverSession.user.id + ':' + auth.serverSession.workspace?.id : users.currentUser?.id} opened={templatesOpen} onOpen={() => setTemplatesOpen(true)} onClose={() => setTemplatesOpen(false)} session={auth.serverSession}
        onLogin={() => { setTemplatesOpen(false); ui.setIsAuthModalOpen(true); }} canApply={users.isLoaded && !budget.saveError && !budget.localRecoveryRequired}
        onShareError={setTemplateError}
        onApply={async (blueprint, snapshot) => { if (auth.serverSession) return ledgers.create(blueprint.title, snapshot); try { users.applyTemplate(blueprint, snapshot); setTemplateError(""); return true; } catch (error) { setTemplateError(error instanceof Error ? error.message : "새 공간을 만들지 못했습니다. 기존 데이터는 교체하지 않았습니다."); return false; } }} />
      <DataModal
           key={'data:' + budget.localScopeKey}
           marketingConsent={marketingConsent}
          importMessage={ui.importMessage}
          importPreview={budget.pendingImport ? { currentCount: budget.fixedCosts.length, targetCount: budget.pendingImport.snapshot.fixedCosts.length,
             currentAmount: budget.summary.monthlyExpense, targetAmount: budget.pendingImport.snapshot.fixedCosts.reduce((sum, item) => sum + (item.periodMonths > 0 ? item.amount / item.periodMonths : 0), 0) } : null}
          onApplyImport={() => { if (canEdit) budget.applyImport(); }}
          onCancelImport={budget.cancelImport}
          opened={ui.isDataModalOpen}
          hasServerApi={Boolean(auth.serverApi)}
          importFileRef={budget.importFileRef}
          backupFileRef={budget.backupFileRef}
          onClose={() => { budget.cancelImport(); ui.setIsDataModalOpen(false); }}
          onExportTemplate={handleExportCsv}
          onImportTemplate={(file) => { if (canEdit) void budget.handleImportTemplate(file); }}
          onExportBackup={handleExportBackupWithTracking}
          onImportBackup={(file) => { if (canEdit) void budget.handleImportBackup(file); }}
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
             canUploadServerSnapshot: sync.canUploadServerSnapshot && syncAvailable,
             isServerBusy: auth.isServerBusy || !syncAvailable,
            serverStatus: auth.serverStatus,
            serverErrorKind: auth.serverErrorKind,
            changeCurrentPassword: auth.changeCurrentPassword,
            changeNewPassword: auth.changeNewPassword,
            showUploadButton: sync.showUploadButton,
            showLoadButton: sync.showLoadButton,
             onServerLogout: handleExitAccount,
            onResendVerification: () => void auth.handleResendVerification(),
            onChangePassword: () => void auth.handleChangePassword(),
            onChangeCurrentPassword: auth.setChangeCurrentPassword,
            onChangeNewPassword: auth.setChangeNewPassword,
            onCheckServer: () => {
               if (auth.serverSession && syncAvailable) {
                void sync.prepareServerSyncDecision(auth.serverSession);
              }
            },
             onSyncNow: () => { if (syncAvailable) void sync.handleSyncNow(); },
             onLoadSnapshot: () => { if (syncAvailable) void sync.handleLoadServerSnapshot(); },
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
           key={'category:' + budget.localScopeKey}
           opened={ui.isCategoryModalOpen && canEdit}
          categories={budget.categories}
          onAdd={budget.handleAddCategory}
          onRename={budget.handleRenameCategory}
          onDelete={budget.handleDeleteCategory}
          onClose={() => ui.setIsCategoryModalOpen(false)}
        />

      <CardModal
           key={'card:' + budget.localScopeKey}
           opened={ui.isCardModalOpen && canEdit}
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
