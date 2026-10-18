"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Text } from "@mantine/core";
import { COACH_MODEL_APPROX_MB, COACH_MODEL_ID, COACH_MODEL_VRAM_MB, isWebGpuAvailable } from "./lib/coachModel";
import { track } from "./lib/analytics";
import { renewalQueue } from "./lib/costViews";
import { AppHeader } from "./components/AppHeader";
import { useMarketingConsent } from "./lib/useMarketingConsent";
import { BudgetStrip } from "./components/BudgetStrip";
import { MetricGrid } from "./components/MetricGrid";
import { InsightsPanel } from "./components/InsightsPanel";
import { ChartSection } from "./components/ChartSection";
import { FixedCostTable } from "./components/FixedCostTable";
import { UpcomingDues } from "./components/UpcomingDues";
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
import { usePlanningData } from './lib/usePlanningData';
import type { PlanningDataApi } from './lib/usePlanningData';
import type { PlanningImportAdapter } from './lib/planningStorage';
import { WeeklyBudgetPanel } from './components/WeeklyBudgetPanel';
import { ReservePanel } from './components/ReservePanel';
import { MonthReviewPanel } from './components/MonthReviewPanel';
import { createDefaultWorkspacePlanningData } from '@living-cost-manager/shared';
import { combinePlanningStorageState, getHeaderStorageView } from './lib/syncStatus';
import { createFocusIntentController, type FocusDestination, type FocusIntentHandler } from './lib/focusIntent';
import { buildHomePlan } from './lib/homePlan';
import { tourNeedsManagementOpen } from './lib/productTour';
import { CROSS_LEDGER_AGGREGATION_AVAILABLE } from './lib/publicRelease';
import { useProductTour } from './lib/useProductTour';
import { ProductTour } from './components/ProductTour';
import { useCoachingPreferences } from "./lib/useCoachingPreferences";
import { CoachingPreferencesPanel } from "./components/CoachingPreferencesPanel";

export default function Home() {
  // Hook creation order respects render-time data flow:
  //   ui → auth → users → budget → coach → sync
  // The two async back-edges (auth → users/sync) go through latest-value refs
  // below — their handlers only run from events/post-boot effects.
  const ui = useUIState();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateError, setTemplateError] = useState("");
  const [workspaceToolsOpen, setWorkspaceToolsOpen] = useState(false);
  const marketingConsent = useMarketingConsent();
  const usersRef = useRef<LocalUsersApi | null>(null);
  const budgetRef = useRef<BudgetDataApi | null>(null);
  const syncRef = useRef<WorkspaceSyncApi | null>(null);
  const planningRef = useRef<PlanningDataApi | null>(null);
  const planningAdapterRef = useRef<{ current: PlanningImportAdapter | null }>({ current: null });

  const auth = useServerAuth({
    ui,
    getUsers: () => usersRef.current as LocalUsersApi,
    getSync: () => syncRef.current as WorkspaceSyncApi
  });
  const users = useLocalUsers({
    ui,
    auth,
    saveBeforeSwitch: () => (budgetRef.current?.saveBeforeSwitch() ?? false) && (planningRef.current?.saveBeforeSwitch() ?? true),
    getBudget: () => (budgetRef.current as BudgetDataApi).getCurrentBudgetSnapshot()
  });
  const budget = useBudgetData({ users, ui, session: auth.serverSession, marketingPersonal: !auth.serverSession && !users.currentUser?.serverUserId, planning: planningAdapterRef.current });
  const coachingPrefs = useCoachingPreferences(budget.fixedCosts, users.currentUser?.id ?? null, auth.serverSession?.workspace?.id ?? null, auth.serverApi, auth.serverSession, users.currentUser?.serverUserId);
  const coach = useCoach({ budget, serverApi: auth.serverApi, protectedFixedCostIds: coachingPrefs.activeIds, coachingPreferencesReady: coachingPrefs.ready });
  const sync = useWorkspaceSync({ ui, auth, budget, coach, localUserId: budget.localScopeKey,
    isLocalDataReady: !!budget.localScopeKey && !budget.saveError && !users.isSampleMode,
    getPlanning: () => planningRef.current });
  const ledgers = useLedgers(auth, sync);
  const planning = usePlanningData({
    profileId: budget.localScopeKey,
    serverSession: auth.serverSession,
    serverApi: auth.serverApi,
    role: sync.currentWorkspaceRole,
    getBudgetServerVersion: sync.getBudgetServerVersion,
    isBudgetServerCurrent: sync.isBudgetServerCurrent,
    isBudgetDirty: sync.isBudgetDirty,
    scopeReady: !users.isSampleMode && !!auth.serverSession?.workspace && !!auth.serverApi
  });
  planningRef.current = planning;
  planningAdapterRef.current.current = planning.importAdapter;
  const viewer = !users.isSampleMode && sync.currentWorkspaceRole === 'viewer';
  const canEdit = !viewer && !ledgers.aggregateMode && !!budget.localScopeKey;
  // 헤더 저장 주장 = 가계부 ∧ 계획 동시 확인. 계획 로컬 쓰기 실패/대기가 우선하고,
  // no-op 계획은 가계부 상태를 흔들지 않는다(거짓 경보 없음).
  const combinedHeaderStorageView = getHeaderStorageView(combinePlanningStorageState(sync.headerStorageState, {
    saveError: planning.loaded && !!planning.saveError,
    savePending: planning.savePending,
    active: planning.planningActive,
    serverDirty: planning.planningServerDirty,
    serverUnknown: planning.planningServerUnknown
  }));
  const syncAvailable = !!budget.localScopeKey && !budget.saveError && !users.isSampleMode && !ledgers.mutationPending;
  const focusReady = users.isBootLoaded && users.isLoaded && (!!budget.localScopeKey || !!budget.saveError);
  const focusScope = JSON.stringify([auth.serverSession?.user.id ?? null, auth.serverSession?.workspace?.id ?? null, users.isSampleMode]);
  const tour = useProductTour({
    ready: focusReady && !auth.isServerBusy,
    scope: users.isSampleMode ? 'sample:' + (users.currentUser?.id ?? 'guest') : auth.serverSession ? 'account:' + auth.serverSession.user.id : 'local:' + (users.currentUser?.id ?? 'guest'),
    transition: focusScope + ':' + budget.localScopeKey,
    account: !users.isSampleMode && auth.serverSession && auth.serverApi ? { id: auth.serverSession.user.id, token: auth.serverSession.token, baseUrl: auth.serverApi.baseUrl } : null
  });
  const tourPaused = templatesOpen || ui.isDataModalOpen || ui.isAuthModalOpen || ui.isDeleteAccountModalOpen || ui.isCategoryModalOpen || ui.isCardModalOpen || coach.isCoachModalOpen || auth.resetToken !== null || auth.verifyNoticeEmail !== null;
  const [, notifyFocus] = useState(0);
  const focusController = useRef<ReturnType<typeof createFocusIntentController> | null>(null);
  if (!focusController.current) focusController.current = createFocusIntentController(() => notifyFocus(value => value + 1));
  const focusTargets = useRef<Record<FocusDestination, HTMLElement | null>>({ ledger: null, create: null, rename: null, aggregate: null, sample: null });
  const focusIntent: FocusIntentHandler = (destination, source, nextWorkspaceId) => {
    const toScope = JSON.stringify([auth.serverSession?.user.id ?? null, nextWorkspaceId ?? auth.serverSession?.workspace?.id ?? null,
      destination === 'sample' ? !users.isSampleMode : users.isSampleMode]);
    const ticket = focusController.current!.begin({ destination, source, fromScope: focusScope, toScope });
    return completed => focusController.current!.complete(ticket, completed);
  };
  useEffect(() => { focusController.current!.flush(focusScope, focusReady, focusTargets.current); });
  useEffect(() => () => focusController.current!.cancel(), []);
  const [reviewDate, setReviewDate] = useState(() => new Date().toDateString());
  const [referenceInstant, setReferenceInstant] = useState(() => new Date());
  useEffect(() => {
    const refresh = () => { setReviewDate(new Date().toDateString()); setReferenceInstant(new Date()); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const reviewItems = useMemo(() => renewalQueue(budget.fixedCosts, new Date(reviewDate)), [budget.fixedCosts, reviewDate]);
  // 첫 화면의 모든 금액은 이 한 번의 파생에서 나온다(BudgetStrip·UpcomingDues 공유).
  const homePlan = useMemo(
    () => buildHomePlan(budget.fixedCosts, budget.monthlyIncome, referenceInstant),
    [budget.fixedCosts, budget.monthlyIncome, referenceInstant]
  );
  // 둘러보기의 '항목 추가'·'납부일 확인' 단계는 접힌 항목 관리를 필요로 한다:
  // 해당 단계에서만 패널을 펼치고 다른 단계·포커스는 건드리지 않는다.
  useEffect(() => {
    if (tourNeedsManagementOpen(tour.step)) budget.requestManagementOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.step]);

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
    // 계획이 로딩된 스코프면 LCM2(가계부+계획)로 내보낸다. 미로딩이면 기존 LCM1
    // 바이트 포맷(가계부만)이고, 이는 "계획 없음"이 아니라 "계획 정보 미포함"이다.
    budget.handleExportBackup(planning.loaded ? planning.data : undefined);
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
      if (!budget.saveBeforeSwitch() || !planning.saveBeforeSwitch() || !users.handleLogout()) return;
      auth.handleServerLogout(); setTemplatesOpen(false);
    } catch { setTemplateError('가계부나 계획을 안전하게 저장하지 못해 로그아웃하지 않았습니다. 현재 내용을 백업하세요.'); }
  }

  if (!users.isBootLoaded || !users.isLoaded || (!budget.localScopeKey && !budget.saveError)) {
    return (
      <main className="page-shell quiet-home">
      {templateError ? <Text role="alert" c="rose" mt="md">{templateError}</Text> : null}
        <section className="login-card">
          <p className="section-label">생활비 관리자</p>
          <h1>불러오는 중입니다</h1>
          {budget.saveError ? <><Text role="alert">{budget.saveError}</Text><Button onClick={handleExportBackupWithTracking}>현재 메모리 데이터 백업</Button></> : null}
        </section>
      </main>
    );
  }

  return (
    <>
      <a className="skip-link" href={ledgers.aggregateMode ? '#aggregate-result' : '#fixed-costs'} onClick={ledgers.aggregateMode ? undefined : budget.requestManagementOpen}>{ledgers.aggregateMode ? '합산 결과로 건너뛰기' : '고정비 편집으로 건너뛰기'}</a>
      <AppHeader
        ledgerControls={auth.serverSession ? <LedgerControls key={auth.serverSession.user.id + ':' + auth.serverSession.workspace?.id} session={auth.serverSession} workspaces={sync.serverWorkspaces} onSwitch={sync.handleSelectServerWorkspace} ledgers={ledgers} canSwitch={!!budget.localScopeKey && !budget.saveError && !users.isSampleMode}
          onFocusIntent={focusIntent} focusRef={(destination, element) => { focusTargets.current[destination] = element; }} /> : null}
        saveError={budget.saveError}
        onRetrySave={budget.retrySave}
        onExportUnsaved={budget.handleExportBackup}
        recoveryRequired={budget.localRecoveryRequired}
        lastSavedAt={budget.lastSavedAt}
        serverSession={auth.serverSession}
        currentUserName={budget.profileName}
        headerStorageView={combinedHeaderStorageView}
        onOpenData={() => ui.setIsDataModalOpen(true)}
        onOpenAuth={() => ui.setIsAuthModalOpen(true)}
        onOpenCoach={coach.openCoachModal}
        onViewPreparedCoach={coach.viewPreparedCoaching}
        onOpenTemplates={() => { setTemplateError(""); setTemplatesOpen(true); }}
        onOpenTour={() => tour.start(document.querySelector<HTMLElement>('[data-product-tour-opener]') ?? undefined)}
        onServerLogout={handleExitAccount}
        coachHeaderIndicator={coach.headerIndicator}
        coachHeaderProgressLabel={coach.headerProgressLabel}
        coachHeaderReadyLabel={coach.headerReadyLabel}
      />
      <main className="page-shell quiet-home">
      <ProductTour tour={tour} signedIn={!!auth.serverSession && !users.isSampleMode} paused={tourPaused} readOnly={viewer} />
      {templateError ? <Text role="alert" aria-live="assertive" c="rose" mb="md">{templateError}</Text> : null}
      {users.templateReturnId ? <div className="workspace-note"><Text size="sm">템플릿으로 만든 새 공간입니다. 기존 데이터는 보존되어 있습니다.</Text><Button variant="default" onClick={() => setTemplateError(users.returnFromTemplate() ?? "")}>템플릿 적용 전 공간으로 돌아가기</Button></div> : null}
      {CROSS_LEDGER_AGGREGATION_AVAILABLE && ledgers.aggregateMode ? <section id="aggregate-result" tabIndex={-1} aria-label="합산 보기">{ledgers.aggregate ? <LedgerSummary summary={ledgers.aggregate.totals} fromDate={ledgers.aggregate.fromDate} untilDateExclusive={ledgers.aggregate.untilDateExclusive} aggregate /> : <Text role="status">합산할 가계부를 선택하고 조회하세요. 자동으로 전체 가계부를 선택하지 않습니다.</Text>}</section> : <>
      {viewer ? <Text role="status">보기 전용 가계부입니다. 편집과 업로드는 할 수 없습니다.</Text> : null}
      {/* 빈 기기 + 확인된 서버 데이터: 자동 적용 대신 명시적 불러오기 CTA 한 번만 제안한다. */}
      {sync.showEmptyDeviceLoadOffer ? (
        <div className="workspace-note" role="note">
          <Text size="sm">서버에 저장된 가계부가 있어요.</Text>
          <Button size="sm" variant="default" disabled={!syncAvailable} onClick={sync.handleEmptyDeviceLoad}>
            서버에서 불러오기
          </Button>
        </div>
      ) : null}
      <section className="home-overview" aria-label="이번 달 계획과 납부 예정">
        <BudgetStrip
          plan={homePlan}
          canEdit={canEdit}
          onIncomeChange={budget.handleIncomeChange}
        />
        <UpcomingDues
          fixedCosts={budget.fixedCosts}
          asOf={referenceInstant}
          plan={homePlan}
          onRevealItem={budget.revealItem}
          paydayDay={planning.loaded ? planning.data.paydayDay : null}
        />
        {budget.fixedCosts.length === 0 && canEdit ? (
          <div className="home-onboarding">
            <Text size="sm">고정비로 기록할 항목만 추가하면 됩니다. 변동지출·실제 잔액은 추적하지 않습니다.</Text>
            <Button variant="default" onClick={budget.handleAddItem}>기록할 항목 추가</Button>
          </div>
        ) : null}
      </section>
      {planning.loaded ? (
        <WeeklyBudgetPanel
          data={planning.data}
          asOf={referenceInstant}
          canEdit={planning.canEdit}
          isViewer={planning.isViewer}
          hasServer={!users.isSampleMode && !!auth.serverSession?.workspace && !!auth.serverApi}
          serverSupport={planning.serverSupport}
          serverConfirmed={planning.baseConfirmed}
          serverDirty={planning.planningServerDirty}
          conflict={planning.conflict}
          saveError={planning.saveError}
          actions={planning}
        />
      ) : null}
      {planning.loaded ? (
        <ReservePanel
          planning={planning.data}
          fixedCosts={budget.fixedCosts}
          asOf={referenceInstant}
          canEdit={planning.canEdit}
          actions={{ editReserve: planning.editReserve, deleteReserve: planning.deleteReserve, linkReserve: planning.linkReserve }}
        />
      ) : null}
      <MonthReviewPanel
        planning={planning.loaded ? planning.data : createDefaultWorkspacePlanningData()}
        fixedCosts={budget.fixedCosts}
        monthlyIncome={budget.monthlyIncome}
        scopeKey={budget.localScopeKey ?? ""}
        asOf={referenceInstant}
        canEdit={canEdit}
        isViewer={viewer}
        actions={{
          saveRecoveryCopy: budget.saveCurrentRecoveryCopy,
          applyPatches: patches => {
            if (!canEdit) return { ok: false, message: "현재는 편집할 수 없어 적용하지 않았습니다." };
            if (!budget.saveBeforeSwitch()) return { ok: false, message: "가계부 저장 상태를 먼저 확인하세요." };
            if (patches.newIncome !== null) budget.handleIncomeChange(patches.newIncome);
            for (const patch of patches.costs) budget.handleItemChange(patch.costId, { amount: patch.newAmount });
            return { ok: true, message: "재발 변경을 가계부에 반영했습니다(복구본 저장 후, 서버 업로드는 아직)." };
          }
        }}
      />
      {users.isSampleMode ? <Text role="status" size="sm" mb="sm">샘플 체험 중 · 내 데이터와 분리된 예시입니다.</Text> : null}
      {budget.localRecoveryRequired ? <Button color="rose" variant="default" mb="sm" onClick={budget.handleExportRecovery}>저장 원본 내보내기</Button> : null}

      <section className="workspace" id="fixed-costs" tabIndex={-1} aria-label="고정비 편집">
        <div className="management-bar">
          <button
            type="button"
            className="management-toggle"
            aria-expanded={budget.managementOpen}
            aria-controls="management-panel"
            onClick={budget.toggleManagementOpen}
          >
            <span aria-hidden="true" className="management-toggle-chevron">{budget.managementOpen ? "▾" : "▸"}</span>
            항목 관리 · {budget.fixedCosts.length}개
          </button>
          <Text size="xs" c="dimmed">
            {budget.managementOpen ? "접으면 첫 화면이 단순해집니다" : "펼치면 추가 · 빠른 추가 · 필터 · 삭제 모드 · 카테고리 · 카드 · 데이터 관리"}
          </Text>
        </div>
        {/* 한 번만 DOM 에 존재하는 정본 테이블: 접기/disabled 로 감추되 언마운트하지
            않아 draft·포커스·저장 상태가 유지된다. */}
        <div id="management-panel" className="management-panel" hidden={!budget.managementOpen}>
          <fieldset disabled={!canEdit} className="ledger-edit-region">
            {budget.canUndoDelete ? <Button variant="light" onClick={budget.handleUndoDelete}>최근 삭제 취소</Button> : null}

            <div className="editor-layout">
              <div className="workspace-main">
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
                  protectedIds={coachingPrefs.activeIds}
                  onToggleProtected={coachingPrefs.ready ? coachingPrefs.toggle : undefined}
                />
              </div>

            </div>
          </fieldset>
        </div>
        <CoachingPreferencesPanel items={budget.fixedCosts} {...coachingPrefs} canCloudAccess={coachingPrefs.canCloudAccess} />
        {/* 갱신 검토·분석은 읽기 전용(가계부 쓰기 없음): 전체를 감추는 fieldset 으로
            summary/버튼을 죽이지 않고 열 수 있게 한다. */}
        {reviewItems.length > 0 ? <details className="quiet-disclosure renewal-queue" aria-label="갱신 검토 작업목록">
          <summary>갱신 검토 · {reviewItems.length}건</summary>
          <Text size="sm" c="dimmed">오늘부터 30일간 미검토 · 해지 예정 · 변경 검토. 예정 절감은 실제 절감이 아닙니다.</Text>
          <div className="renewal-actions">
            {reviewItems.map(item => <Button key={item.id} variant="subtle" onClick={() => budget.revealItem(item.id)}>
              {item.name} · {item.renewalStatus === 'cancel-planned' ? '해지 예정' : item.renewalStatus === 'change-review' ? '변경 검토' : '임박 미검토'} 편집
            </Button>)}
          </div>
        </details> : null}
        <details className="quiet-disclosure">
          <summary>지출 분석</summary>
          <div className="dashboard-overview">
            <MetricGrid summary={budget.summary} fixedCostCount={budget.fixedCosts.length} />
            <InsightsPanel fixedCosts={budget.fixedCosts} monthlyIncome={homePlan.monthlyIncome} monthlyExpense={homePlan.monthlyExpense} protectedFixedCostIds={coachingPrefs.activeIds} coachingPreferencesReady={coachingPrefs.ready} onKeepItem={coachingPrefs.ready ? coachingPrefs.toggle : undefined} onRequestEdit={budget.requestManagementOpen} />
          </div>
          {budget.summary.monthlyExpense > 0 && (
              <details className="quiet-charts">
                <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '12px 16px', border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'var(--surface)' }}>
                  카테고리별 비중
                </summary>
                <div style={{ padding: '16px', border: '1px solid var(--line)', borderTop: 0, borderRadius: '0 0 var(--radius) var(--radius)', background: 'var(--surface)' }}>
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
                </div>
              </details>
            )}
        </details>
      </section>
      <details className="quiet-disclosure workspace-tools" open={workspaceToolsOpen} onToggle={event => setWorkspaceToolsOpen(event.currentTarget.open)}>
        <summary>샘플 및 복구 도구</summary>
        <Text size="sm" c="dimmed">샘플은 내 데이터와 분리되며 서버로 업로드하지 않습니다.</Text>
        <Button ref={element => { focusTargets.current.sample = element; }} variant="default" onClick={event => {
          const done = focusIntent('sample', event.currentTarget);
          void users.handleChooseDataMode(users.isSampleMode ? 'blank' : 'sample').then(() => done()).catch(() => {
            done(false); setTemplateError('가계부 저장에 실패하여 샘플 전환을 중단했습니다. 현재 내용을 백업하세요.');
          });
        }}>{users.isSampleMode ? '내 데이터로 시작 / 돌아가기' : '분리된 샘플 체험'}</Button>
        <Button variant="subtle" color={budget.localRecoveryRequired ? 'rose' : 'gray'} onClick={budget.handleExportRecovery}>{budget.localRecoveryRequired ? '저장 원본 내보내기' : '최근 교체 전 복구본 내보내기'}</Button>
        {auth.serverSession && !users.isSampleMode ? <Button variant="subtle" color="gray" onClick={budget.handleExportLegacySource}>이전 단일 가계부 원본(JSON) 내보내기</Button> : null}
      </details>
      </>}
      <TemplateModal key={auth.serverSession ? auth.serverSession.user.id + ':' + auth.serverSession.workspace?.id : users.currentUser?.id} opened={templatesOpen} onOpen={() => setTemplatesOpen(true)} onClose={() => setTemplatesOpen(false)} session={auth.serverSession}
        onLogin={() => { setTemplatesOpen(false); ui.setIsAuthModalOpen(true); }} canApply={users.isLoaded && !budget.saveError && !budget.localRecoveryRequired}
        accountCanCreate={ledgers.canCreate} creationUnavailableMessage={ledgers.creationUnavailableMessage}
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
                void planning.checkRemote();
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
          planning={{
            hasWorkspace: !users.isSampleMode && !!auth.serverSession?.workspace && !!auth.serverApi,
            isViewer: planning.isViewer,
            canUpload: canEdit && !users.isSampleMode,
            saveError: planning.loaded ? planning.saveError : "",
            isBusy: planning.isBusy || auth.isServerBusy,
            serverSupport: planning.serverSupport,
            serverConfirmed: planning.baseConfirmed,
            planningActive: planning.planningActive,
            serverDirty: planning.planningServerDirty,
            hasRemoteDivergence: planning.hasRemoteDivergence,
            conflict: planning.conflict,
            lastPlanningSyncedAt: planning.lastPlanningSyncedAt,
            statusMessage: planning.statusMessage,
            localSummary: { weekCount: planning.data.weeks.length, reserveCount: planning.data.reserves.length, paydayDay: planning.data.paydayDay },
            remoteStaged: planning.remoteStaged ? {
              weekCount: planning.remoteStaged.data.weeks.length,
              reserveCount: planning.remoteStaged.data.reserves.length,
              paydayDay: planning.remoteStaged.data.paydayDay,
              checkedAt: planning.remoteStaged.checkedAt,
              rows: [...planning.remoteStaged.data.weeks]
                .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
                .slice(0, 6)
                .map(week => ({ label: week.weekStart.slice(5).replace("-", "/"), budget: week.budgetAmount, spent: week.spentAmount })),
              reserveRows: planning.remoteStaged.data.reserves.slice(0, 6).map(reserve => ({
                label: reserve.costLabel ?? reserve.costId.slice(0, 16),
                saved: reserve.savedAmount,
                target: reserve.targetAmount
              }))
            } : null,
            onCheck: () => void planning.checkRemote(),
            onUpload: () => void planning.uploadNow(),
            onUploadOverwrite: () => {
              if (window.confirm("서버의 계획 기록을 이 기기 기록으로 교체합니다. 다른 멤버의 최근 계획이 대체될 수 있습니다. 계속할까요?")) {
                void planning.uploadNow({ forceStagedRevision: true });
              }
            },
            onAdoptRemote: () => {
              const message = planning.isViewer
                ? "서버 계획 기록을 이 기기에 표시합니다(읽기 사본). 서버는 변경되지 않습니다."
                : "서버 계획 기록을 이 기기에 적용합니다. 현재 기기 계획은 교체 전 복구 사본으로 보관됩니다.";
              if (window.confirm(message)) planning.adoptRemote();
            },
            onCloseComparison: planning.closeRemoteComparison,
            onRetrySave: planning.retrySave
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
          preferencesReady={coachingPrefs.ready}
          opened={coach.isCoachModalOpen}
          webGpuAvailable={isWebGpuAvailable()}
          hasData={coach.coachHasData}
          approxMb={COACH_MODEL_APPROX_MB}
          vramMb={COACH_MODEL_VRAM_MB}
          modelName={COACH_MODEL_ID}
          status={coach.coachStatus}
          loadProgress={coach.coachProgress}
          loadText={coach.coachProgressText}
          coaching={coach.coachingText}
          errorMessage={coach.coachError}
          fallbackHeadline={coach.coachFallbackHeadline}
          awaitingConsent={coach.awaitingConsent}
          preparationState={coach.preparation.state}
          onStart={() => void coach.runCoaching()}
          onRegenerate={() => void coach.runCoaching()}
          onClose={coach.closeCoachModal}
          onConfirmConsent={coach.confirmConsentAndPrepare}
          onContinueWithoutPreparation={coach.continueWithoutModal}
          onCancelPreparation={coach.cancelPreparation}
          onRetryPreparation={coach.retryPreparation}
          onGenerateCoaching={() => void coach.generateCoachingNow()}
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
