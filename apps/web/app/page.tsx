"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { InvitationRole, WorkspaceDto, WorkspaceInvitationDto, WorkspaceMemberDto, WorkspaceSnapshot } from "@living-cost-manager/shared";
import {
  BANK_TRANSFER_OPTIONS,
  buildBudgetSummary,
  createCategory,
  createFixedCost,
  DEFAULT_CATEGORIES,
  deleteCategory,
  getCategoryBuckets,
  getMonthlyEquivalentAmount,
  getCategoryPieSegments,
  getPieSegmentAtPercent,
  isDefaultCategory,
  PAYMENT_METHODS,
  renameCategory,
  updateFixedCost,
  type Category,
  type CategoryPieSegment,
  type FixedCost
} from "./lib/budget";
import { buildFixedCostCsvTemplate, parseFixedCostCsvTemplate } from "./lib/budgetImportExport";
import { buildLivingCostBackup, parseLivingCostBackup } from "./lib/backup";
import {
  createPaymentCard,
  DEFAULT_CARDS,
  deletePaymentCard,
  isDefaultCard,
  normalizePaymentCard,
  renamePaymentCard,
  updatePaymentCard,
  type PaymentCard
} from "./lib/cards";
import { createUser, getUserDataKey, LOCAL_USER_NAME, mergeUsers, resolveStartupUser, type AppUser } from "./lib/users";
import {
  createServerApiClient,
  isServerAuthFailure,
  resolveServerSessionWorkspace,
  ServerApiError,
  SERVER_SESSION_STORAGE_KEY,
  type CreatedInvitation,
  type ServerSession
} from "./lib/serverApi";
import {
  buildWorkspaceSnapshot,
  hasLocalBudgetData,
  hydrateWorkspaceSnapshot,
  isWorkspaceSnapshotEmpty,
  type LocalBudgetSnapshot
} from "./lib/snapshot";
import { canManageSharing, canSyncWorkspace, findCurrentMember, invitationRoleLabels, workspaceRoleLabels } from "./lib/sharing";
import {
  getAccountSyncState,
  getSyncStateView,
  summarizeBudgetSnapshot,
  type AccountSyncState,
  type BudgetSnapshotSummary
} from "./lib/syncStatus";
import {
  buildPieBackground,
  chartColors,
  clampBillingDay,
  formatNumberInput,
  formatSaveTime,
  formatWon,
  getPaymentOptions,
  mergeCards,
  mergeCategories,
  parseCurrencyInput,
  parsePeriodInput
} from "./lib/formatting";
import type { BudgetSnapshot } from "./lib/pageTypes";
import { emptyBudgetSnapshot, sampleBudgetSnapshot, seedFixedCosts } from "./lib/seedData";

const USERS_KEY = "living-cost-manager:users:v1";
const ACTIVE_USER_KEY = "living-cost-manager:active-user:v1";
const STORAGE_KEY = "living-cost-manager:v2";
const LEGACY_STORAGE_KEY = "living-cost-manager:v1";

export default function Home() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [knownUsers, setKnownUsers] = useState<AppUser[]>([]);
  const initialDataMode: "sample" | "blank" = "sample";
  const [monthlyIncome, setMonthlyIncome] = useState(3_000_000);
  const [fixedCosts, setFixedCosts] = useState<FixedCost[]>(seedFixedCosts);
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [cards, setCards] = useState<PaymentCard[]>(DEFAULT_CARDS);
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [newCardLabel, setNewCardLabel] = useState("");
  const [newCardBillingDay, setNewCardBillingDay] = useState(1);
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [isCardModalOpen, setIsCardModalOpen] = useState(false);
  const [isDataModalOpen, setIsDataModalOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  // "login" | "register" lives in serverAuthMode; this adds the forgot-password view.
  const [authView, setAuthView] = useState<"auth" | "forgot">("auth");
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [changeCurrentPassword, setChangeCurrentPassword] = useState("");
  const [changeNewPassword, setChangeNewPassword] = useState("");
  const [chartMode, setChartMode] = useState<"bar" | "pie">("bar");
  const [activePieSegment, setActivePieSegment] = useState<CategoryPieSegment | null>(null);
  const [pieTooltipPosition, setPieTooltipPosition] = useState({ x: 0, y: 0 });
  const [categoryFilterId, setCategoryFilterId] = useState("all");
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedDeleteIds, setSelectedDeleteIds] = useState<string[]>([]);
  const [importMessage, setImportMessage] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState("");
  const [isBootLoaded, setIsBootLoaded] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [serverSession, setServerSession] = useState<ServerSession | null>(null);
  const [serverAuthMode, setServerAuthMode] = useState<"login" | "register">("login");
  const [serverEmail, setServerEmail] = useState("");
  const [serverPassword, setServerPassword] = useState("");
  const [serverName, setServerName] = useState("");
  const [serverStatus, setServerStatus] = useState("");
  const [serverSnapshot, setServerSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [isServerSnapshotChecked, setIsServerSnapshotChecked] = useState(false);
  const [isServerBusy, setIsServerBusy] = useState(false);
  const [serverErrorKind, setServerErrorKind] = useState<"auth" | "request" | null>(null);
  const [lastServerSyncedAt, setLastServerSyncedAt] = useState<Date | null>(null);
  const [lastSyncedSnapshotKey, setLastSyncedSnapshotKey] = useState("");
  const [serverWorkspaces, setServerWorkspaces] = useState<WorkspaceDto[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberDto[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitationDto[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitationRole>("viewer");
  const [acceptTokens, setAcceptTokens] = useState<Record<string, string>>({});
  const [createdInvitation, setCreatedInvitation] = useState<CreatedInvitation | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const backupFileRef = useRef<HTMLInputElement | null>(null);
  const serverRestoreCheckedRef = useRef(false);
  const serverApi = useMemo(() => createServerApiClient(), []);

  useEffect(() => {
    const users = readJson<AppUser[]>(USERS_KEY, []);
    const activeUserId = window.localStorage.getItem(ACTIVE_USER_KEY);
    const storedServerSession = readJson<ServerSession | null>(SERVER_SESSION_STORAGE_KEY, null);
    const validServerSession = isServerSession(storedServerSession) ? storedServerSession : null;
    const startupUser = resolveStartupUser({
      users,
      activeUserId,
      serverUser: validServerSession?.user ?? null
    });

    window.localStorage.setItem(USERS_KEY, JSON.stringify(startupUser.users));
    window.localStorage.setItem(ACTIVE_USER_KEY, startupUser.user.id);
    setKnownUsers(startupUser.users);
    setCurrentUser(startupUser.user);
    if (validServerSession) {
      setServerSession(validServerSession);
      setServerEmail(validServerSession.user.email);
      setServerName(validServerSession.user.name);
    }
    setIsBootLoaded(true);
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return;
    }

    const registerWorker = () => {
      void navigator.serviceWorker.register("./sw.js").catch(() => undefined);
    };

    window.addEventListener("load", registerWorker);
    return () => window.removeEventListener("load", registerWorker);
  }, []);

  useEffect(() => {
    if (!isBootLoaded) {
      return;
    }

    if (!currentUser) {
      setIsLoaded(true);
      return;
    }

    setIsLoaded(false);
    const stored = window.localStorage.getItem(getUserDataKey(currentUser.id));
    const legacyStored = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = parseBudgetSnapshot(stored ?? legacyStored);

    if (parsed.recovered && stored) {
      try {
        window.localStorage.setItem(getUserDataKey(currentUser.id) + ":corrupt:" + Date.now().toString(36), stored);
      } catch {
        // Recovery should continue even if the browser refuses the extra copy.
      }
      setImportMessage("저장 데이터가 손상되어 기본값으로 복구했습니다. 가능하면 전체 백업을 내보내세요.");
    }

    setMonthlyIncome(parsed.snapshot.monthlyIncome);
    setCategories(parsed.snapshot.categories);
    setCards(parsed.snapshot.cards);
    setFixedCosts(parsed.snapshot.fixedCosts);
    setLastSavedAt(null);
    setSaveError("");
    setIsLoaded(true);
  }, [currentUser, isBootLoaded]);

  useEffect(() => {
    if (!isBootLoaded || !isLoaded || !currentUser) {
      return;
    }

    try {
      window.localStorage.setItem(getUserDataKey(currentUser.id), JSON.stringify({ monthlyIncome, fixedCosts, categories, cards }));
      setLastSavedAt(new Date());
      setSaveError("");
    } catch {
      setSaveError("브라우저 저장 공간에 저장하지 못했습니다. 전체 백업을 먼저 내보내세요.");
    }
  }, [cards, categories, currentUser, fixedCosts, isBootLoaded, isLoaded, monthlyIncome]);

  useEffect(() => {
    if (!isCategoryModalOpen && !isCardModalOpen && !isDataModalOpen && !isAuthModalOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsCategoryModalOpen(false);
        setIsCardModalOpen(false);
        setIsDataModalOpen(false);
        setIsAuthModalOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCardModalOpen, isCategoryModalOpen, isDataModalOpen, isAuthModalOpen]);

  useEffect(() => {
    if ((!isDataModalOpen && !isAuthModalOpen) || !serverSession || !serverApi) {
      return;
    }

    void refreshSharing(serverSession);
  }, [isDataModalOpen, isAuthModalOpen, serverApi, serverSession]);

  useEffect(() => {
    if (!isBootLoaded || !serverSession || !serverApi || serverRestoreCheckedRef.current) {
      return;
    }

    serverRestoreCheckedRef.current = true;
    void refreshRestoredServerSession(serverSession);
  }, [isBootLoaded, serverApi, serverSession]);

  // Handle auth deep links delivered by email. The app is a static-export SPA
  // served only at "/", so links use root query params: ?reset_token / ?verify_token.
  useEffect(() => {
    if (typeof window === "undefined" || !serverApi) {
      return;
    }
    const params = new URLSearchParams(window.location.search);

    const reset = params.get("reset_token");
    if (reset) {
      setResetToken(reset);
      return;
    }

    const verify = params.get("verify_token");
    if (verify) {
      clearAuthQueryParam("verify_token");
      void serverApi
        .verifyEmail(verify)
        .then(() => {
          setServerStatus("이메일 인증이 완료되었습니다.");
          setServerSession((current) => {
            if (!current) {
              return current;
            }
            const updated = { ...current, user: { ...current.user, emailVerified: true } };
            saveServerSession(updated);
            return updated;
          });
        })
        .catch(() => {
          setServerStatus("이메일 인증 링크가 유효하지 않거나 만료되었습니다.");
        })
        .finally(() => {
          setIsDataModalOpen(true);
        });
    }
  }, [serverApi]);

  const summary = useMemo(() => buildBudgetSummary(fixedCosts, monthlyIncome), [fixedCosts, monthlyIncome]);
  const buckets = useMemo(() => getCategoryBuckets(fixedCosts, categories), [categories, fixedCosts]);
  const pieSegments = useMemo(() => getCategoryPieSegments(buckets), [buckets]);
  const visibleFixedCosts = useMemo(
    () => (categoryFilterId === "all" ? fixedCosts : fixedCosts.filter((item) => item.categoryId === categoryFilterId)),
    [categoryFilterId, fixedCosts]
  );
  const visibleFixedCostTotal = useMemo(
    () => visibleFixedCosts.reduce((total, item) => total + getMonthlyEquivalentAmount(item), 0),
    [visibleFixedCosts]
  );
  const progressWidth = String(Math.min(summary.expenseRate, 100)) + "%";
  const pieBackground = buildPieBackground(pieSegments);
  const currentServerMember = useMemo(
    () => findCurrentMember(members, serverSession?.user.id),
    [members, serverSession?.user.id]
  );
  const currentWorkspaceRole = currentServerMember?.role ?? serverSession?.workspace?.role ?? null;
  const canManageCurrentWorkspace = canManageSharing(currentWorkspaceRole);
  const canUploadServerSnapshot = canSyncWorkspace(currentWorkspaceRole) && isServerSnapshotChecked;
  const visibleCreatedInvitation =
    canManageCurrentWorkspace && createdInvitation?.workspaceId === serverSession?.workspace?.id ? createdInvitation : null;
  const currentBudgetSnapshot = useMemo(
    () => getCurrentBudgetSnapshotFromState({ monthlyIncome, categories, cards, fixedCosts }),
    [cards, categories, fixedCosts, monthlyIncome]
  );
  const localSnapshotSummary = useMemo(() => summarizeBudgetSnapshot(currentBudgetSnapshot), [currentBudgetSnapshot]);
  const serverSnapshotSummary = useMemo(
    () => (serverSnapshot ? summarizeBudgetSnapshot(hydrateWorkspaceSnapshot(serverSnapshot)) : null),
    [serverSnapshot]
  );
  const hasRemoteDecision =
    !!serverSnapshot &&
    (!isWorkspaceSnapshotEmpty(serverSnapshot) || hasLocalBudgetData(currentBudgetSnapshot));
  const currentSnapshotKey = useMemo(() => buildSnapshotKey(currentBudgetSnapshot), [currentBudgetSnapshot]);
  const isServerSyncCurrent = !!lastSyncedSnapshotKey && currentSnapshotKey === lastSyncedSnapshotKey;
  const accountSyncState = getAccountSyncState({
    hasServerApi: !!serverApi,
    hasSession: !!serverSession,
    hasWorkspace: !!serverSession?.workspace,
    isBusy: isServerBusy,
    isSnapshotChecked: isServerSnapshotChecked,
    hasServerSnapshot: hasRemoteDecision,
    hasAuthFailure: serverErrorKind === "auth",
    hasError: serverErrorKind !== null
  });
  const displayedSyncState: AccountSyncState =
    accountSyncState === "signed-in" && lastServerSyncedAt && isServerSyncCurrent ? "synced" : accountSyncState;
  const syncStateView = getSyncStateView(displayedSyncState);

  function handleIncomeChange(value: string) {
    setMonthlyIncome(parseCurrencyInput(value));
  }

  function handleItemChange(id: string, patch: Partial<Omit<FixedCost, "id">>) {
    setFixedCosts((items) => items.map((item) => (item.id === id ? updateFixedCost(item, patch) : item)));
  }

  function handlePaymentMethodChange(item: FixedCost, paymentMethodId: FixedCost["paymentMethodId"]) {
    const selectedCard = paymentMethodId === "credit-card" ? cards.find((card) => card.id === item.paymentOptionId) : null;
    handleItemChange(item.id, {
      paymentMethodId,
      billingDay: selectedCard?.billingDay ?? item.billingDay
    });
  }

  function handlePaymentOptionChange(item: FixedCost, paymentOptionId: string) {
    const selectedCard = item.paymentMethodId === "credit-card" ? cards.find((card) => card.id === paymentOptionId) : null;
    handleItemChange(item.id, {
      paymentOptionId,
      billingDay: selectedCard?.billingDay ?? item.billingDay
    });
  }

  function handleAddItem() {
    setFixedCosts((items) => [
      ...items,
      createFixedCost({
        id: "cost-" + Date.now().toString(36),
        name: "새 고정비",
        categoryId: categories[0]?.id ?? "other",
        paymentMethodId: "bank-transfer",
        paymentOptionId: "auto-transfer",
        amount: 0,
        periodMonths: 1,
        billingDay: 1
      })
    ]);
  }

  function handleEnterDeleteMode() {
    setIsDeleteMode(true);
    setSelectedDeleteIds([]);
    setImportMessage("");
  }

  function handleCancelDeleteMode() {
    setIsDeleteMode(false);
    setSelectedDeleteIds([]);
  }

  function handleToggleDeleteSelection(id: string) {
    setSelectedDeleteIds((ids) => (ids.includes(id) ? ids.filter((selectedId) => selectedId !== id) : [...ids, id]));
  }

  function handleConfirmDeleteItems() {
    if (selectedDeleteIds.length === 0) {
      setImportMessage("삭제할 항목을 선택하세요.");
      return;
    }

    const deleteCount = selectedDeleteIds.length;
    const shouldDelete = window.confirm(deleteCount + "개 항목을 삭제할까요?");
    if (!shouldDelete) {
      return;
    }

    setFixedCosts((items) => items.filter((item) => !selectedDeleteIds.includes(item.id)));
    setSelectedDeleteIds([]);
    setIsDeleteMode(false);
    setImportMessage(deleteCount + "개 항목을 삭제했습니다.");
  }

  function handleAddCategory() {
    const nextCategory = createCategory(newCategoryLabel);
    setCategories((currentCategories) => mergeCategories(currentCategories, [nextCategory]));
    setNewCategoryLabel("");
  }

  function handleRenameCategory(categoryId: string, label: string) {
    setCategories((currentCategories) => renameCategory(currentCategories, categoryId, label));
  }

  function handleDeleteCategory(categoryId: string) {
    setCategories((currentCategories) => {
      const result = deleteCategory(currentCategories, fixedCosts, categoryId);
      setFixedCosts(result.items);
      return result.categories;
    });
    if (categoryFilterId === categoryId) {
      setCategoryFilterId("all");
    }
  }

  function handleAddCard() {
    const nextCard = createPaymentCard(newCardLabel, newCardBillingDay);
    setCards((currentCards) => mergeCards(currentCards, [nextCard]));
    setNewCardLabel("");
    setNewCardBillingDay(1);
  }

  function handleRenameCard(cardId: string, label: string) {
    setCards((currentCards) => renamePaymentCard(currentCards, cardId, label));
  }

  function handleUpdateCardBillingDay(cardId: string, billingDay: number) {
    const nextBillingDay = clampBillingDay(billingDay);
    setCards((currentCards) => updatePaymentCard(currentCards, cardId, { billingDay: nextBillingDay }));
    setFixedCosts((items) =>
      items.map((item) =>
        item.paymentMethodId === "credit-card" && item.paymentOptionId === cardId
          ? updateFixedCost(item, { billingDay: nextBillingDay })
          : item
      )
    );
  }

  function handleDeleteCard(cardId: string) {
    setCards((currentCards) => {
      const result = deletePaymentCard(currentCards, fixedCosts, cardId);
      setFixedCosts(result.items);
      return result.cards;
    });
  }

  function handleLogin(userName: string) {
    const nextUser = createUser(userName);
    const isNewUser = !knownUsers.some((user) => user.id === nextUser.id);
    const nextUsers = mergeUsers(knownUsers, nextUser);
    const userDataKey = getUserDataKey(nextUser.id);

    window.localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
    window.localStorage.setItem(ACTIVE_USER_KEY, nextUser.id);
    if (currentUser && currentUser.id !== nextUser.id) {
      window.localStorage.setItem(userDataKey, JSON.stringify(getCurrentBudgetSnapshot()));
    } else if (isNewUser && !window.localStorage.getItem(userDataKey)) {
      const snapshot = initialDataMode === "blank" ? emptyBudgetSnapshot : sampleBudgetSnapshot;
      window.localStorage.setItem(userDataKey, JSON.stringify(snapshot));
    }
    setKnownUsers(nextUsers);
    setIsLoaded(false);
    setCurrentUser(nextUser);
  }

  function handleLogout() {
    const localUser = createUser(LOCAL_USER_NAME);
    const nextUsers = mergeUsers(knownUsers, localUser);

    window.localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
    window.localStorage.setItem(ACTIVE_USER_KEY, localUser.id);
    setKnownUsers(nextUsers);
    setCurrentUser(localUser);
    setIsLoaded(false);
    setIsCategoryModalOpen(false);
    setIsCardModalOpen(false);
    setIsDataModalOpen(false);
    setIsDeleteMode(false);
    setSelectedDeleteIds([]);
  }

  async function handleServerAuthSubmit() {
    if (!serverApi) {
      setServerStatus("서버 API URL이 없어 로컬 전용으로 동작합니다.");
      return;
    }

    const validationError =
      validateEmail(serverEmail) ??
      validatePassword(serverPassword) ??
      (serverAuthMode === "register" ? validateName(serverName) : null);
    if (validationError) {
      setServerErrorKind("request");
      setServerStatus(validationError);
      return;
    }

    setIsServerBusy(true);
    setServerStatus("");
    setServerErrorKind(null);

    try {
      const authResult =
        serverAuthMode === "register"
          ? await serverApi.register({ email: serverEmail, password: serverPassword, name: serverName || serverEmail })
          : await serverApi.login({ email: serverEmail, password: serverPassword });
      const nextSession = await resolveAndStoreServerSession({
        ...authResult,
        workspace: authResult.workspace ?? serverSession?.workspace ?? null
      });

      serverRestoreCheckedRef.current = true;
      setServerPassword("");
      if (isAuthModalOpen) {
        setIsAuthModalOpen(false);
        setIsDataModalOpen(true);
      }
      await prepareServerSyncDecision(nextSession);
      await refreshSharing(nextSession);
      handleLogin(nextSession.user.name || nextSession.user.email);
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  function handleServerLogout() {
    // Best-effort server-side logout (invalidates refresh tokens); ignore failures.
    if (serverApi && serverSession) {
      void serverApi.logout(serverSession.token).catch(() => undefined);
    }
    window.localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
    setServerSession(null);
    setServerSnapshot(null);
    setIsServerSnapshotChecked(false);
    setServerWorkspaces([]);
    setMembers([]);
    setInvitations([]);
    setServerErrorKind(null);
    setLastServerSyncedAt(null);
    setLastSyncedSnapshotKey("");
    clearWorkspaceScopedSharingDrafts();
    setServerStatus("서버 연결을 해제했습니다. 브라우저 데이터는 유지됩니다.");
  }

  async function handleForgotPassword() {
    if (!serverApi) {
      return;
    }
    const validationError = validateEmail(serverEmail);
    if (validationError) {
      setServerErrorKind("request");
      setServerStatus(validationError);
      return;
    }
    setIsServerBusy(true);
    setServerStatus("");
    setServerErrorKind(null);
    try {
      await serverApi.forgotPassword(serverEmail);
      setServerStatus("입력하신 이메일이 가입되어 있다면 재설정 링크를 보냈습니다. 메일함을 확인하세요.");
    } catch (error) {
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  async function handleResetPassword() {
    if (!serverApi || !resetToken) {
      return;
    }
    const validationError = validatePassword(resetPasswordValue);
    if (validationError) {
      setServerErrorKind("request");
      setServerStatus(validationError);
      return;
    }
    setIsServerBusy(true);
    setServerStatus("");
    setServerErrorKind(null);
    try {
      await serverApi.resetPassword(resetToken, resetPasswordValue);
      setResetPasswordValue("");
      setResetToken(null);
      clearAuthQueryParam("reset_token");
      setServerAuthMode("login");
      setAuthView("auth");
      setIsAuthModalOpen(true);
      setServerStatus("비밀번호를 재설정했습니다. 새 비밀번호로 로그인하세요.");
    } catch (error) {
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  async function handleChangePassword() {
    if (!serverApi || !serverSession) {
      return;
    }
    if (!changeCurrentPassword) {
      setServerErrorKind("request");
      setServerStatus("현재 비밀번호를 입력해주세요.");
      return;
    }
    const newPasswordError = validatePassword(changeNewPassword);
    if (newPasswordError) {
      setServerErrorKind("request");
      setServerStatus(newPasswordError === "비밀번호를 입력해주세요." ? "새 비밀번호를 입력해주세요." : "새 " + newPasswordError);
      return;
    }
    setIsServerBusy(true);
    setServerStatus("");
    setServerErrorKind(null);
    try {
      const updated = await serverApi.changePassword(
        changeCurrentPassword,
        changeNewPassword,
        serverSession.token
      );
      // change-password bumps tokenVersion and returns fresh tokens; keep workspace.
      const nextSession = await resolveAndStoreServerSession({
        ...updated,
        workspace: updated.workspace ?? serverSession.workspace ?? null
      });
      setServerSession(nextSession);
      setChangeCurrentPassword("");
      setChangeNewPassword("");
      setServerStatus("비밀번호를 변경했습니다.");
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(
        isServerAuthFailure(error) ? "현재 비밀번호가 올바르지 않습니다." : getErrorMessage(error)
      );
    } finally {
      setIsServerBusy(false);
    }
  }

  async function handleResendVerification() {
    if (!serverApi || !serverSession) {
      return;
    }
    setIsServerBusy(true);
    setServerStatus("");
    try {
      await serverApi.resendVerification(serverSession.token);
      setServerStatus("인증 메일을 다시 보냈습니다. 메일함을 확인하세요.");
    } catch (error) {
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  async function prepareServerSyncDecision(session: ServerSession) {
    if (!serverApi) {
      setIsServerSnapshotChecked(false);
      return false;
    }

    setIsServerSnapshotChecked(false);
    setServerSnapshot(null);
    setServerErrorKind(null);

    if (!session.workspace) {
      setServerStatus("서버 계정은 연결됐지만 선택된 워크스페이스가 없습니다. 초대 수락 후 동기화를 사용할 수 있습니다.");
      return false;
    }

    try {
      const remoteSnapshot = await serverApi.getWorkspaceSnapshot(session.workspace.id, session.token);
      setServerSnapshot(remoteSnapshot);
      setIsServerSnapshotChecked(true);

      if (isWorkspaceSnapshotEmpty(remoteSnapshot) && hasLocalBudgetData(getCurrentBudgetSnapshot())) {
        setServerStatus("서버 워크스페이스가 비어 있습니다. 이 브라우저 데이터를 업로드할 수 있습니다.");
        return true;
      }

      if (!isWorkspaceSnapshotEmpty(remoteSnapshot)) {
        setServerStatus("서버 데이터가 있습니다. 불러오거나 현재 브라우저 데이터로 동기화할 수 있습니다.");
        return true;
      }

      setServerStatus("서버 워크스페이스와 연결되었습니다. 로컬 전용으로 계속해도 됩니다.");
      return true;
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getServerSyncErrorMessage(error) + " 서버 상태 확인 전에는 업로드를 막습니다. 로컬 저장은 계속 유지됩니다.");
      return false;
    }
  }

  async function refreshRestoredServerSession(session: ServerSession) {
    if (!serverApi) {
      return;
    }

    // The stored access token is short-lived; if it has expired, transparently
    // exchange the refresh token for a new pair before restoring the session.
    let activeSession = session;
    try {
      await serverApi.me(session.token);
    } catch (probeError) {
      if (isServerAuthFailure(probeError)) {
        try {
          const refreshed = await serverApi.refresh(session.refreshToken);
          activeSession = { ...refreshed, workspace: refreshed.workspace ?? session.workspace };
          saveServerSession(activeSession);
          setServerSession(activeSession);
        } catch {
          // refresh token also invalid -> fall through to the catch below via me()
        }
      }
    }

    try {
      const [{ user }, nextSession] = await Promise.all([
        serverApi.me(activeSession.token),
        resolveServerSessionWorkspace(serverApi, activeSession)
      ]);
      const restoredSession = {
        ...nextSession,
        user
      };

      saveServerSession(restoredSession);
      setServerSession(restoredSession);
      setServerErrorKind(null);
      await loadServerWorkspaces(restoredSession);
      if (restoredSession.workspace) {
        await prepareServerSyncDecision(restoredSession);
      } else {
        setServerStatus("사용 가능한 서버 워크스페이스가 없습니다.");
      }
    } catch (error) {
      if (isServerAuthFailure(error)) {
        window.localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
        setServerSession(null);
        setServerWorkspaces([]);
        setIsServerSnapshotChecked(false);
        setServerErrorKind("auth");
        setServerStatus(getServerSyncErrorMessage(error));
        return;
      }
      setServerErrorKind("request");
      setServerStatus(getServerSyncErrorMessage(error) + " 서버 연결은 유지했습니다. 데이터 관리에서 다시 시도하세요.");
    }
  }

  async function resolveAndStoreServerSession(session: ServerSession) {
    if (!serverApi) {
      saveServerSession(session);
      setServerSession(session);
      setIsServerSnapshotChecked(false);
      return session;
    }

    const nextSession = await resolveServerSessionWorkspace(serverApi, session);
    saveServerSession(nextSession);
    setServerSession(nextSession);
    setServerErrorKind(null);
    setIsServerSnapshotChecked(false);
    await loadServerWorkspaces(nextSession);
    return nextSession;
  }

  async function loadServerWorkspaces(session = serverSession) {
    if (!serverApi || !session) {
      setServerWorkspaces([]);
      return [];
    }

    const workspaces = await serverApi.listWorkspaces(session.token);
    setServerWorkspaces(workspaces);
    return workspaces;
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

    saveServerSession(nextSession);
    setServerSession(nextSession);
    setIsServerSnapshotChecked(false);
    clearWorkspaceScopedSharingDrafts();
    setMembers([]);
    setServerSnapshot(null);
    if (workspace) {
      await prepareServerSyncDecision(nextSession);
      await refreshSharing(nextSession);
    } else {
      setServerStatus("사용 가능한 서버 워크스페이스가 없습니다.");
    }
  }

  async function handleSyncNow() {
    if (!serverApi || !serverSession?.workspace) {
      setServerStatus("동기화할 서버 워크스페이스가 없습니다.");
      return;
    }

    if (!canUploadServerSnapshot) {
      setServerStatus(isServerSnapshotChecked ? "보기 전용 권한은 서버에 업로드할 수 없습니다." : "서버 상태 확인이 끝난 뒤 업로드할 수 있습니다.");
      return;
    }

    setIsServerBusy(true);
    try {
      const nextSnapshot = buildWorkspaceSnapshot(serverSession.workspace.id, getCurrentBudgetSnapshot());
      const savedSnapshot = await serverApi.putWorkspaceSnapshot(serverSession.workspace.id, nextSnapshot, serverSession.token);
      setServerSnapshot(savedSnapshot);
      setLastServerSyncedAt(new Date());
      setLastSyncedSnapshotKey(buildSnapshotKey(hydrateWorkspaceSnapshot(savedSnapshot)));
      setServerErrorKind(null);
      setServerStatus("현재 브라우저 데이터를 서버에 동기화했습니다.");
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getServerSyncErrorMessage(error) + " 로컬 저장은 계속 유지됩니다.");
    } finally {
      setIsServerBusy(false);
    }
  }

  async function handleLoadServerSnapshot() {
    if (!serverApi || !serverSession?.workspace) {
      setServerStatus("불러올 서버 워크스페이스가 없습니다.");
      return;
    }

    setIsServerBusy(true);
    try {
      const nextSnapshot = serverSnapshot ?? (await serverApi.getWorkspaceSnapshot(serverSession.workspace.id, serverSession.token));
      applyBudgetSnapshot(hydrateWorkspaceSnapshot(nextSnapshot));
      setServerSnapshot(nextSnapshot);
      setLastServerSyncedAt(new Date());
      setLastSyncedSnapshotKey(buildSnapshotKey(hydrateWorkspaceSnapshot(nextSnapshot)));
      setServerErrorKind(null);
      setServerStatus("서버 데이터를 이 브라우저에 불러왔습니다.");
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getServerSyncErrorMessage(error) + " 로컬 데이터는 변경하지 않았습니다.");
    } finally {
      setIsServerBusy(false);
    }
  }

  function handleStayLocalOnly() {
    setServerStatus("로컬 전용으로 계속합니다. 서버 연결은 유지되지만 데이터를 덮어쓰지 않습니다.");
  }

  async function refreshSharing(session = serverSession) {
    if (!serverApi || !session) {
      return;
    }

    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        session.workspace ? serverApi.listMembers(session.workspace.id, session.token) : Promise.resolve([]),
        serverApi.listInvitations(session.token)
      ]);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
      setServerErrorKind(null);
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getServerSyncErrorMessage(error));
    }
  }

  async function handleCreateInvitation() {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    setIsServerBusy(true);
    try {
      const invitation = await serverApi.createInvitation(serverSession.workspace.id, { email: inviteEmail, role: inviteRole }, serverSession.token);
      setCreatedInvitation(invitation);
      setInviteEmail("");
      setServerStatus("초대를 만들었습니다. 아래 토큰을 초대받은 사용자에게 전달하세요.");
      setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  async function handleAcceptInvitation(invitationId: string) {
    if (!serverApi || !serverSession) {
      return;
    }

    const tokenValue = acceptTokens[invitationId]?.trim() ?? "";
    if (!tokenValue) {
      setServerStatus("초대 토큰을 입력하세요.");
      return;
    }

    setIsServerBusy(true);
    try {
      const accepted = await serverApi.acceptInvitation(invitationId, tokenValue, serverSession.token);
      const nextSession = await resolveAndStoreServerSession({ ...serverSession, workspace: accepted.workspace });
      clearWorkspaceScopedSharingDrafts();
      setServerStatus("초대를 수락했습니다. 새 워크스페이스가 선택되었습니다.");
      setServerErrorKind(null);
      await prepareServerSyncDecision(nextSession);
      await refreshSharing(nextSession);
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  async function handleUpdateMemberRole(memberId: string, role: WorkspaceMemberDto["role"]) {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    setIsServerBusy(true);
    try {
      await serverApi.updateMemberRole(serverSession.workspace.id, memberId, role, serverSession.token);
      setServerStatus("멤버 권한을 변경했습니다.");
      setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  async function handleDeleteMember(memberId: string) {
    if (!serverApi || !serverSession?.workspace || !canManageCurrentWorkspace) {
      return;
    }

    if (!window.confirm("이 멤버를 워크스페이스에서 제거할까요?")) {
      return;
    }

    setIsServerBusy(true);
    try {
      await serverApi.deleteMember(serverSession.workspace.id, memberId, serverSession.token);
      setServerStatus("멤버를 제거했습니다.");
      setServerErrorKind(null);
      await refreshSharing(serverSession);
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getServerSyncErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  function handleExportTemplate() {
    const csv = buildFixedCostCsvTemplate({ fixedCosts, categories, cards });
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "fixed-cost-template.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setImportMessage("템플릿을 내보냈습니다.");
  }

  function handleExportBackup() {
    const backup = buildLivingCostBackup({ monthlyIncome, fixedCosts, categories, cards });
    const blob = new Blob([backup], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "living-cost-backup.lcm";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setImportMessage("전체 백업을 내보냈습니다.");
  }

  async function handleImportTemplate(file: File | null) {
    if (!file) {
      return;
    }

    try {
      const result = parseFixedCostCsvTemplate({
        csv: await file.text(),
        categories,
        cards
      });

      setCategories(result.categories);
      setCards(result.cards);
      setFixedCosts(result.fixedCosts);
      setImportMessage(result.importedCount + "개 항목을 가져왔습니다.");
    } catch {
      setImportMessage("가져오기에 실패했습니다.");
    } finally {
      if (importFileRef.current) {
        importFileRef.current.value = "";
      }
    }
  }

  async function handleImportBackup(file: File | null) {
    if (!file) {
      return;
    }

    try {
      const result = parseLivingCostBackup(await file.text());

      setMonthlyIncome(result.monthlyIncome);
      setCategories(result.categories);
      setCards(result.cards);
      setFixedCosts(result.fixedCosts);
      setCategoryFilterId("all");
      setIsDeleteMode(false);
      setSelectedDeleteIds([]);
      setImportMessage("전체 백업을 가져왔습니다.");
    } catch {
      setImportMessage("전체 백업 가져오기에 실패했습니다.");
    } finally {
      if (backupFileRef.current) {
        backupFileRef.current.value = "";
      }
    }
  }

  function getCurrentBudgetSnapshot(): LocalBudgetSnapshot {
    return {
      monthlyIncome,
      categories,
      cards,
      fixedCosts
    };
  }

  function applyBudgetSnapshot(snapshot: LocalBudgetSnapshot) {
    setMonthlyIncome(snapshot.monthlyIncome);
    setCategories(snapshot.categories);
    setCards(snapshot.cards);
    setFixedCosts(snapshot.fixedCosts);
    setCategoryFilterId("all");
    setIsDeleteMode(false);
    setSelectedDeleteIds([]);
  }

  function saveServerSession(session: ServerSession) {
    window.localStorage.setItem(SERVER_SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  function clearWorkspaceScopedSharingDrafts() {
    setCreatedInvitation(null);
    setInviteEmail("");
    setInviteRole("viewer");
    setAcceptTokens({});
  }

  function handlePieMove(event: MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const angle = Math.atan2(x - centerX, centerY - y);
    const percent = (((angle < 0 ? angle + Math.PI * 2 : angle) / (Math.PI * 2)) * 100);

    setActivePieSegment(getPieSegmentAtPercent(pieSegments, percent));
    setPieTooltipPosition({ x, y });
  }

  if (!isBootLoaded || !isLoaded) {
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
      <header className="app-header">
        <span className={saveError ? "save-status save-status-error" : "save-status"}>
          {saveError || (lastSavedAt ? "저장됨 " + formatSaveTime(lastSavedAt) : "브라우저 저장 대기")}
        </span>
        {serverSession ? (
          <button className="account-status-pill account-status-connected" type="button" onClick={() => setIsDataModalOpen(true)}>
            서버 연결됨 · 동기화 관리
          </button>
        ) : (
          <>
            <button className="secondary-button" type="button" onClick={() => setIsDataModalOpen(true)}>
              데이터 관리
            </button>
            <button className="primary-button" type="button" onClick={() => setIsAuthModalOpen(true)}>
              클라우드에 저장하기
            </button>
          </>
        )}
        <strong>{currentUser?.name ?? LOCAL_USER_NAME}</strong>
        {serverSession ? (
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              handleServerLogout();
              handleLogout();
            }}
          >
            서버 로그아웃
          </button>
        ) : null}
      </header>
      <section className="hero">
        <div>
          <p className="section-label">고정비 대시보드</p>
          <h1>생활비 고정비를 한 화면에서 정리하세요</h1>
          <p className="hero-copy">
            매월 또는 몇 개월마다 반복되는 지출을 항목, 납부일, 결제수단별로 모아 보고 월 환산 예산 압박을 바로 확인합니다.
          </p>
          <p className="local-note inline-note">
            {serverSession?.workspace
              ? "서버 계정이 연결되어 있습니다. 변경 후 데이터 관리에서 서버 동기화를 실행하세요."
              : "현재 로그인 없이 로컬 저장 중입니다. 로그인해서 클라우드에 저장하면 기기를 바꿔도 데이터를 이어서 사용할 수 있습니다."}
          </p>
        </div>
        <div className="summary-panel" aria-label="이번 달 고정비 요약">
          <label htmlFor="monthly-income">월 수입</label>
          <input
            id="monthly-income"
            inputMode="numeric"
            min="0"
            type="text"
            value={formatNumberInput(monthlyIncome)}
            onChange={(event) => handleIncomeChange(event.target.value)}
          />
          <p>수입 대비 월 환산 고정비 {summary.expenseRate}%</p>
          <div className="income-progress" aria-label="수입 대비 월 환산 고정비 비율">
            <div className="income-progress-fill" style={{ width: progressWidth }} />
          </div>
        </div>
      </section>

      <section className="metric-grid" aria-label="핵심 지표">
        <article>
          <span>월 환산 고정비</span>
          <strong>{formatWon(summary.monthlyExpense)}</strong>
          <small>연 환산 {formatWon(summary.annualExpense)}</small>
        </article>
        <article>
          <span>남는 금액</span>
          <strong className={summary.remainingIncome < 0 ? "danger-text" : undefined}>
            {formatWon(summary.remainingIncome)}
          </strong>
          <small>{summary.remainingIncome < 0 ? "수입보다 고정비가 큽니다" : "고정비 차감 후"}</small>
        </article>
        <article>
          <span>등록 항목</span>
          <strong>{fixedCosts.length}개</strong>
        </article>
        <article>
          <span>가장 큰 항목</span>
          <strong>{summary.highestCost?.name ?? "없음"}</strong>
          <small>{summary.highestCost ? "월 환산 " + formatWon(getMonthlyEquivalentAmount(summary.highestCost)) : "항목을 추가하세요"}</small>
        </article>
        <article>
          <span>평균 고정비</span>
          <strong>{formatWon(summary.averageExpense)}</strong>
        </article>
      </section>

      <section className="workspace">
        <div className="cost-list">
          <div className="section-heading">
            <div>
              <p className="section-label">납부 일정</p>
              <h2>고정비 항목</h2>
            </div>
            {isDeleteMode ? (
              <div className="action-group delete-actions">
                <span className="selection-count">{selectedDeleteIds.length}개 선택</span>
                <button className="secondary-button" type="button" onClick={handleCancelDeleteMode}>
                  취소
                </button>
                <button className="danger-button" type="button" onClick={handleConfirmDeleteItems}>
                  선택 삭제
                </button>
              </div>
            ) : (
              <div className="action-group">
                <button className="secondary-button" type="button" onClick={() => setIsCategoryModalOpen(true)}>
                  카테고리 관리
                </button>
                <button className="secondary-button" type="button" onClick={() => setIsCardModalOpen(true)}>
                  카드 관리
                </button>
                <button className="secondary-button" type="button" onClick={() => setIsDataModalOpen(true)}>
                  데이터 관리
                </button>
                <button className="warning-button" type="button" onClick={handleEnterDeleteMode}>
                  삭제 모드
                </button>
                <button className="primary-button" type="button" onClick={handleAddItem}>
                  항목 추가
                </button>
              </div>
            )}
          </div>
          {importMessage ? <p className="import-status">{importMessage}</p> : null}
          <div className="filter-bar" aria-label="카테고리 필터">
            <label htmlFor="category-filter">카테고리 보기</label>
            <select
              id="category-filter"
              value={categoryFilterId}
              onChange={(event) => {
                setCategoryFilterId(event.target.value);
                setSelectedDeleteIds([]);
              }}
            >
              <option value="all">전체</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
            </select>
            <span>{visibleFixedCosts.length}개 항목</span>
            <strong>월 환산 {formatWon(visibleFixedCostTotal)}</strong>
          </div>
          <div className="table" role="table" aria-label="고정비 목록">
            <div className={isDeleteMode ? "table-row table-head delete-mode" : "table-row table-head"} role="row">
              <span>항목</span>
              <span>카테고리</span>
              <span>결제수단</span>
              <span>결제 옵션</span>
              <span>납부일</span>
              <span>금액</span>
              <span>주기</span>
              <span>월 환산</span>
              {isDeleteMode ? <span>선택</span> : null}
            </div>
            {visibleFixedCosts.map((item) => (
              <div className={isDeleteMode ? "table-row delete-mode" : "table-row"} role="row" key={item.id}>
                <span>
                  <label className="sr-only" htmlFor={item.id + "-name"}>
                    항목명
                  </label>
                  <input
                    id={item.id + "-name"}
                    type="text"
                    value={item.name}
                    onChange={(event) => handleItemChange(item.id, { name: event.target.value })}
                  />
                </span>
                <span>
                  <label className="sr-only" htmlFor={item.id + "-category"}>
                    카테고리
                  </label>
                  <select
                    id={item.id + "-category"}
                    value={item.categoryId}
                    onChange={(event) => handleItemChange(item.id, { categoryId: event.target.value })}
                  >
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </span>
                <span>
                  <label className="sr-only" htmlFor={item.id + "-payment-method"}>
                    결제수단
                  </label>
                  <select
                    id={item.id + "-payment-method"}
                    value={item.paymentMethodId}
                    onChange={(event) => handlePaymentMethodChange(item, event.target.value as FixedCost["paymentMethodId"])}
                  >
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method.id} value={method.id}>
                        {method.label}
                      </option>
                    ))}
                  </select>
                </span>
                <span>
                  <label className="sr-only" htmlFor={item.id + "-payment"}>
                    결제 옵션
                  </label>
                  <select
                    id={item.id + "-payment"}
                    value={item.paymentOptionId}
                    onChange={(event) => handlePaymentOptionChange(item, event.target.value)}
                    disabled={getPaymentOptions(item.paymentMethodId, cards).length === 0}
                  >
                    {getPaymentOptions(item.paymentMethodId, cards).length === 0 ? (
                      <option value=""></option>
                    ) : null}
                    {getPaymentOptions(item.paymentMethodId, cards).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </span>
                <span>
                  <label className="sr-only" htmlFor={item.id + "-billing-day"}>
                    납부일
                  </label>
                  <input
                    id={item.id + "-billing-day"}
                    disabled={item.paymentMethodId === "credit-card" && item.paymentOptionId.length > 0}
                    max="31"
                    min="1"
                    type="number"
                    value={item.billingDay}
                    onChange={(event) => handleItemChange(item.id, { billingDay: parseCurrencyInput(event.target.value) })}
                  />
                </span>
                <span>
                  <label className="sr-only" htmlFor={item.id + "-amount"}>
                    금액
                  </label>
                  <input
                    id={item.id + "-amount"}
                    inputMode="numeric"
                    min="0"
                    type="text"
                    value={formatNumberInput(item.amount)}
                    onChange={(event) => handleItemChange(item.id, { amount: parseCurrencyInput(event.target.value) })}
                  />
                </span>
                <span>
                  <label className="sr-only" htmlFor={item.id + "-period"}>
                    주기
                  </label>
                  <input
                    id={item.id + "-period"}
                    className="period-input"
                    inputMode="numeric"
                    max="120"
                    min="1"
                    step="0.1"
                    type="number"
                    value={item.periodMonths}
                    onChange={(event) => handleItemChange(item.id, { periodMonths: parsePeriodInput(event.target.value) })}
                  />
                  <small className="input-suffix">개월</small>
                </span>
                <span className="monthly-equivalent-cell">
                  <strong>{formatWon(getMonthlyEquivalentAmount(item))}</strong>
                  <small>{item.periodMonths}개월 기준</small>
                </span>
                {isDeleteMode ? (
                  <span className="delete-select-cell">
                    <label className="delete-checkbox" htmlFor={item.id + "-delete"}>
                      <input
                        checked={selectedDeleteIds.includes(item.id)}
                        id={item.id + "-delete"}
                        type="checkbox"
                        onChange={() => handleToggleDeleteSelection(item.id)}
                      />
                      <span className="sr-only">삭제 선택</span>
                    </label>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <aside className="diagram" aria-label="카테고리별 고정비 비중">
          <div className="section-heading">
            <div>
              <p className="section-label">도식화</p>
              <h2>카테고리별 비중</h2>
            </div>
            <div className="chart-toggle" aria-label="도식화 보기 방식">
              <button className={chartMode === "bar" ? "active" : undefined} type="button" onClick={() => setChartMode("bar")}>
                막대
              </button>
              <button className={chartMode === "pie" ? "active" : undefined} type="button" onClick={() => setChartMode("pie")}>
                원형
              </button>
            </div>
          </div>
          {chartMode === "bar" ? (
            <div className="bars">
              {buckets.map((bucket) => (
                <div className="bar-row" key={bucket.categoryId}>
                  <div className="bar-meta">
                    <span>{bucket.label}</span>
                    <strong>{formatWon(bucket.amount)}</strong>
                  </div>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: summary.monthlyExpense > 0 ? String((bucket.amount / summary.monthlyExpense) * 100) + "%" : "0%" }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="pie-layout">
              <div
                className="pie-chart"
                style={{ background: pieBackground }}
                aria-label="카테고리별 원형 차트"
                onMouseLeave={() => setActivePieSegment(null)}
                onMouseMove={handlePieMove}
              >
                <span>{summary.monthlyExpense > 0 ? "100%" : "0%"}</span>
                {activePieSegment ? (
                  <div
                    className="pie-tooltip"
                    style={{ left: pieTooltipPosition.x, top: pieTooltipPosition.y }}
                    role="tooltip"
                  >
                    <strong>{activePieSegment.label}</strong>
                    <span>{formatWon(activePieSegment.amount)}</span>
                    <small>{activePieSegment.percent}%</small>
                  </div>
                ) : null}
              </div>
              <div className="pie-legend">
                {pieSegments.map((segment, index) => (
                  <div
                    className={activePieSegment?.categoryId === segment.categoryId ? "pie-legend-row active" : "pie-legend-row"}
                    key={segment.categoryId}
                  >
                    <span className="legend-color" style={{ background: chartColors[index % chartColors.length] }} />
                    <span>{segment.label}</span>
                    <strong>{segment.percent}%</strong>
                    <small>{formatWon(segment.amount)}</small>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </section>

      {isDataModalOpen ? (
        <div className="modal-backdrop" onMouseDown={() => setIsDataModalOpen(false)}>
          <section
            aria-labelledby="data-modal-title"
            aria-modal="true"
            className="category-modal data-modal"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="section-label">관리</p>
                <h2 id="data-modal-title">데이터 관리</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setIsDataModalOpen(false)}>
                닫기
              </button>
            </div>
            <div className="data-action-grid">
              <section className="data-action-panel">
                <div>
                  <p className="section-label">엑셀 템플릿</p>
                  <h3>항목 일괄 편집</h3>
                  <small>고정비 항목만 CSV로 편집합니다.</small>
                </div>
                <div className="data-action-buttons">
                  <button className="secondary-button" type="button" onClick={handleExportTemplate}>
                    템플릿 Export
                  </button>
                  <button className="secondary-button" type="button" onClick={() => importFileRef.current?.click()}>
                    Import
                  </button>
                </div>
              </section>
              <section className="data-action-panel">
                <div>
                  <p className="section-label">LCM 백업</p>
                  <h3>전체 백업</h3>
                  <small>수입, 카테고리, 카드, 고정비를 모두 저장합니다.</small>
                </div>
                <div className="data-action-buttons">
                  <button className="secondary-button" type="button" onClick={handleExportBackup}>
                    전체 Export
                  </button>
                  <button className="secondary-button" type="button" onClick={() => backupFileRef.current?.click()}>
                    전체 Import
                  </button>
                </div>
              </section>
            </div>
            {serverApi ? (
              <section className="server-panel" aria-label="서버 동기화">
                <div className="server-panel-header">
                  <div>
                    <p className="section-label">서버 동기화</p>
                    <h3>계정 및 공유</h3>
                  </div>
                  {serverSession ? (
                    <button className="secondary-button" type="button" onClick={handleServerLogout}>
                      서버 로그아웃
                    </button>
                  ) : null}
                </div>

                <div className={"sync-state-card sync-state-" + syncStateView.tone}>
                  <div>
                    <span>현재 저장 모드</span>
                    <strong>{syncStateView.label}</strong>
                    <small>{syncStateView.description}</small>
                  </div>
                  <div>
                    <span>마지막 서버 동기화</span>
                    <strong>{lastServerSyncedAt ? formatSaveTime(lastServerSyncedAt) : "아직 없음"}</strong>
                    <small>{serverSession?.workspace ? serverSession.workspace.name : "서버 워크스페이스 선택 전"}</small>
                  </div>
                </div>

                {displayedSyncState === "local-only" || displayedSyncState === "server-available" ? (
                  <div className="local-mode-warning" role="status">
                    <strong>로컬 모드: 이 브라우저에만 저장됩니다.</strong>
                    <p>브라우저 데이터를 삭제하거나 기기를 바꾸면 복구할 수 없습니다. 로그인해서 클라우드에 저장하면 다른 기기에서도 이어서 사용할 수 있습니다.</p>
                    <button className="secondary-button" type="button" onClick={handleExportBackup}>
                      전체 Export 백업
                    </button>
                  </div>
                ) : null}

                <div className="sync-summary-grid" aria-label="동기화 데이터 비교">
                  <BudgetSummaryCard title="이 브라우저" summary={localSnapshotSummary} />
                  {serverSnapshotSummary ? (
                    <BudgetSummaryCard title="서버 데이터" summary={serverSnapshotSummary} />
                  ) : (
                    <div className="sync-summary-card muted">
                      <span>서버 데이터</span>
                      <strong>확인 전</strong>
                      <small>서버 상태 확인을 누르면 비교 정보가 표시됩니다.</small>
                    </div>
                  )}
                </div>

                {serverSession ? (
                  <div className="server-session-summary">
                    <div>
                      <span>계정</span>
                      <strong>{serverSession.user.name}</strong>
                      <small>{serverSession.user.email}</small>
                    </div>
                    <div>
                      <span>워크스페이스</span>
                      <strong>{serverSession.workspace?.name ?? "선택 안 됨"}</strong>
                      <small>{currentWorkspaceRole ? workspaceRoleLabels[currentWorkspaceRole] : "초대 수락 후 선택"}</small>
                      {serverWorkspaces.length > 1 ? (
                        <select
                          aria-label="서버 워크스페이스 선택"
                          value={serverSession.workspace?.id ?? ""}
                          onChange={(event) => void handleSelectServerWorkspace(event.target.value)}
                        >
                          {serverWorkspaces.map((workspace) => (
                            <option key={workspace.id} value={workspace.id}>
                              {workspace.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {serverSession && serverSession.user.emailVerified === false ? (
                  <div className="email-verify-badge" role="status">
                    <span>이메일 미인증</span>
                    <button
                      className="link-button"
                      type="button"
                      disabled={isServerBusy}
                      onClick={() => void handleResendVerification()}
                    >
                      인증 메일 재발송
                    </button>
                  </div>
                ) : null}

                {serverSession ? (
                  <details className="password-change">
                    <summary>비밀번호 변경</summary>
                    <form
                      className="server-auth-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleChangePassword();
                      }}
                    >
                      <div className="form-field">
                        <label htmlFor="change-current">현재 비밀번호</label>
                        <input
                          id="change-current"
                          type="password"
                          value={changeCurrentPassword}
                          onChange={(event) => setChangeCurrentPassword(event.target.value)}
                        />
                      </div>
                      <div className="form-field">
                        <label htmlFor="change-new">새 비밀번호</label>
                        <input
                          id="change-new"
                          type="password"
                          value={changeNewPassword}
                          onChange={(event) => setChangeNewPassword(event.target.value)}
                        />
                      </div>
                      <button
                        className="secondary-button"
                        type="submit"
                        disabled={isServerBusy || changeCurrentPassword.length < 8 || changeNewPassword.length < 8}
                      >
                        비밀번호 변경
                      </button>
                    </form>
                  </details>
                ) : null}

                {!serverSession ? (
                  <div className="server-auth-cta">
                    <p>클라우드에 저장하려면 로그인이 필요합니다. 계정이 없으면 가입한 뒤 이어서 사용할 수 있습니다.</p>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => {
                        setIsDataModalOpen(false);
                        setIsAuthModalOpen(true);
                      }}
                    >
                      로그인 / 가입하기
                    </button>
                  </div>
                ) : null}

                {serverStatus ? <p className={serverErrorKind ? "sync-status sync-status-error" : "sync-status"}>{serverStatus}</p> : null}
                {serverSession && serverWorkspaces.length === 0 ? (
                  <p className="local-note">사용 가능한 서버 워크스페이스가 없습니다. 새 계정을 만들거나 초대를 수락한 뒤 동기화를 사용할 수 있습니다.</p>
                ) : null}

                {serverSession?.workspace ? (
                  <div className="sync-actions">
                    <button
                      className="secondary-button"
                      disabled={isServerBusy}
                      type="button"
                      onClick={() => void prepareServerSyncDecision(serverSession)}
                    >
                      서버 상태 확인
                    </button>
                    <button
                      className="secondary-button"
                      disabled={isServerBusy || !canUploadServerSnapshot}
                      type="button"
                      onClick={() => void handleSyncNow()}
                    >
                      지금 동기화
                    </button>
                    {serverSnapshot && isWorkspaceSnapshotEmpty(serverSnapshot) && hasLocalBudgetData(getCurrentBudgetSnapshot()) ? (
                      <button
                        className="secondary-button"
                        disabled={isServerBusy || !canUploadServerSnapshot}
                        type="button"
                        onClick={() => void handleSyncNow()}
                      >
                        이 브라우저 데이터 업로드
                      </button>
                    ) : null}
                    {serverSnapshot && !isWorkspaceSnapshotEmpty(serverSnapshot) ? (
                      <button className="secondary-button" disabled={isServerBusy} type="button" onClick={() => void handleLoadServerSnapshot()}>
                        서버 데이터 불러오기
                      </button>
                    ) : null}
                    <button className="secondary-button" disabled={isServerBusy} type="button" onClick={handleStayLocalOnly}>
                      로컬 전용 유지
                    </button>
                  </div>
                ) : null}

                {serverSession && invitations.length > 0 ? (
                  <section className="sharing-block">
                    <div>
                      <p className="section-label">받은 초대</p>
                      <h4>대기 중인 초대</h4>
                    </div>
                    <div className="sharing-list">
                      {invitations.map((invitation) => (
                        <div className="invitation-row" key={invitation.id}>
                          <div>
                            <strong>{invitation.email}</strong>
                            <small>{invitationRoleLabels[invitation.role]} · {invitation.id}</small>
                          </div>
                          <input
                            aria-label="초대 토큰"
                            placeholder="초대 토큰"
                            type="text"
                            value={acceptTokens[invitation.id] ?? ""}
                            onChange={(event) => setAcceptTokens((tokens) => ({ ...tokens, [invitation.id]: event.target.value }))}
                          />
                          <button className="secondary-button" disabled={isServerBusy} type="button" onClick={() => void handleAcceptInvitation(invitation.id)}>
                            수락
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                {serverSession?.workspace ? (
                  <section className="sharing-block" aria-label="공유 관리">
                    <div className="server-panel-header">
                      <div>
                        <p className="section-label">공유 관리</p>
                        <h4>멤버와 초대</h4>
                      </div>
                      <button className="secondary-button" disabled={isServerBusy} type="button" onClick={() => void refreshSharing()}>
                        새로고침
                      </button>
                    </div>

                    <div className="sharing-list">
                      {members.map((member) => (
                        <div className="member-row" key={member.id}>
                          <div>
                            <strong>{member.name}</strong>
                            <small>{member.email}</small>
                          </div>
                          {canManageCurrentWorkspace ? (
                            <select
                              aria-label="멤버 권한"
                              value={member.role}
                              onChange={(event) => void handleUpdateMemberRole(member.id, event.target.value as WorkspaceMemberDto["role"])}
                            >
                              {(["owner", "editor", "viewer"] as const).map((role) => (
                                <option key={role} value={role}>
                                  {workspaceRoleLabels[role]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="role-pill">{workspaceRoleLabels[member.role]}</span>
                          )}
                          {canManageCurrentWorkspace ? (
                            <button className="ghost-button" disabled={isServerBusy} type="button" onClick={() => void handleDeleteMember(member.id)}>
                              제거
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>

                    {canManageCurrentWorkspace ? (
                      <div className="invite-panel">
                        <div className="form-field">
                          <label htmlFor="invite-email">초대 이메일</label>
                          <input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
                        </div>
                        <div className="form-field">
                          <label htmlFor="invite-role">권한</label>
                          <select id="invite-role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as InvitationRole)}>
                            {(["viewer", "editor"] as const).map((role) => (
                              <option key={role} value={role}>
                                {invitationRoleLabels[role]}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button className="secondary-button" disabled={isServerBusy} type="button" onClick={() => void handleCreateInvitation()}>
                          초대 생성
                        </button>
                      </div>
                    ) : (
                      <p className="local-note">공유 변경은 소유자만 할 수 있습니다.</p>
                    )}

                    {visibleCreatedInvitation?.token ? (
                      <div className="created-token">
                        <div className="form-field">
                          <label htmlFor="created-invitation-token">방금 만든 초대 토큰</label>
                          <input id="created-invitation-token" readOnly type="text" value={visibleCreatedInvitation.token} />
                        </div>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => void navigator.clipboard?.writeText(visibleCreatedInvitation.token ?? "")}
                        >
                          토큰 복사
                        </button>
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </section>
            ) : (
              <div className="local-mode-warning" role="status">
                <strong>서버 API URL이 없어 로컬 전용으로 동작합니다.</strong>
                <p>이 브라우저에만 저장되며, 브라우저 데이터 삭제나 기기 교체 시 복구할 수 없습니다. 전체 Export 백업을 보관하세요.</p>
                <button className="secondary-button" type="button" onClick={handleExportBackup}>
                  전체 Export 백업
                </button>
              </div>
            )}
            <p className="local-note">브라우저 저장은 항상 유지됩니다. 서버 동기화와 별도로 기기를 바꾸기 전에는 전체 Export로 백업하세요.</p>
            <input
              ref={importFileRef}
              className="sr-only"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => void handleImportTemplate(event.target.files?.[0] ?? null)}
            />
            <input
              ref={backupFileRef}
              className="sr-only"
              type="file"
              accept=".lcm,text/plain"
              onChange={(event) => void handleImportBackup(event.target.files?.[0] ?? null)}
            />
          </section>
        </div>
      ) : null}

      {isAuthModalOpen ? (
        <div className="modal-backdrop" onMouseDown={() => setIsAuthModalOpen(false)}>
          <section
            aria-labelledby="auth-modal-title"
            aria-modal="true"
            className="category-modal auth-modal"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="section-label">클라우드</p>
                <h2 id="auth-modal-title">{serverAuthMode === "register" ? "계정 가입" : "로그인"}</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setIsAuthModalOpen(false)}>
                닫기
              </button>
            </div>
            {serverApi ? (
              authView === "forgot" ? (
                <>
                  <p className="auth-modal-intro">
                    가입한 이메일로 비밀번호 재설정 링크를 보내드립니다.
                  </p>
                  <form
                    className="server-auth-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleForgotPassword();
                    }}
                  >
                    <div className="form-field">
                      <label htmlFor="forgot-email">이메일</label>
                      <input
                        id="forgot-email"
                        type="email"
                        value={serverEmail}
                        onChange={(event) => setServerEmail(event.target.value)}
                      />
                    </div>
                    <button className="primary-button" disabled={isServerBusy} type="submit">
                      재설정 링크 보내기
                    </button>
                  </form>
                  <p className="auth-modal-switch">
                    <button type="button" className="link-button" onClick={() => setAuthView("auth")}>
                      로그인으로 돌아가기
                    </button>
                  </p>
                  {serverStatus ? <p className={serverErrorKind ? "sync-status sync-status-error" : "sync-status"}>{serverStatus}</p> : null}
                </>
              ) : (
              <>
                <p className="auth-modal-intro">
                  클라우드에 저장하면 다른 기기에서도 데이터를 이어서 사용할 수 있습니다. 브라우저 로컬 저장은 그대로 유지됩니다.
                </p>
                <form
                  className="server-auth-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleServerAuthSubmit();
                  }}
                >
                  <div className="chart-toggle" aria-label="서버 계정 모드">
                    <button className={serverAuthMode === "login" ? "active" : undefined} type="button" onClick={() => setServerAuthMode("login")}>
                      로그인
                    </button>
                    <button className={serverAuthMode === "register" ? "active" : undefined} type="button" onClick={() => setServerAuthMode("register")}>
                      가입
                    </button>
                  </div>
                  <div className="form-field">
                    <label htmlFor="auth-email">이메일</label>
                    <input id="auth-email" type="email" value={serverEmail} onChange={(event) => setServerEmail(event.target.value)} />
                  </div>
                  {serverAuthMode === "register" ? (
                    <div className="form-field">
                      <label htmlFor="auth-name">이름</label>
                      <input id="auth-name" type="text" value={serverName} onChange={(event) => setServerName(event.target.value)} />
                    </div>
                  ) : null}
                  <div className="form-field">
                    <label htmlFor="auth-password">비밀번호</label>
                    <input
                      id="auth-password"
                      type="password"
                      value={serverPassword}
                      onChange={(event) => setServerPassword(event.target.value)}
                    />
                  </div>
                  <button className="primary-button" disabled={isServerBusy} type="submit">
                    {serverAuthMode === "register" ? "가입하고 클라우드에 저장" : "로그인"}
                  </button>
                </form>
                <p className="auth-modal-switch">
                  {serverAuthMode === "login" ? (
                    <>
                      계정이 없으신가요?{" "}
                      <button type="button" className="link-button" onClick={() => setServerAuthMode("register")}>
                        가입하기
                      </button>
                      <br />
                      <button type="button" className="link-button" onClick={() => { setAuthView("forgot"); setServerStatus(""); }}>
                        비밀번호를 잊으셨나요?
                      </button>
                    </>
                  ) : (
                    <>
                      이미 계정이 있으신가요?{" "}
                      <button type="button" className="link-button" onClick={() => setServerAuthMode("login")}>
                        로그인하기
                      </button>
                    </>
                  )}
                </p>
                {serverStatus ? <p className={serverErrorKind ? "sync-status sync-status-error" : "sync-status"}>{serverStatus}</p> : null}
              </>
              )
            ) : (
              <div className="local-mode-warning" role="status">
                <strong>서버 API URL이 없어 클라우드 저장을 사용할 수 없습니다.</strong>
                <p>이 브라우저에만 저장됩니다. 데이터 관리에서 전체 Export 백업을 보관하세요.</p>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {resetToken ? (
        <div className="modal-backdrop" onMouseDown={() => { setResetToken(null); clearAuthQueryParam("reset_token"); }}>
          <section
            aria-labelledby="reset-modal-title"
            aria-modal="true"
            className="category-modal auth-modal"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="section-label">클라우드</p>
                <h2 id="reset-modal-title">비밀번호 재설정</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => { setResetToken(null); clearAuthQueryParam("reset_token"); }}>
                닫기
              </button>
            </div>
            <p className="auth-modal-intro">새 비밀번호를 입력하세요. (최소 8자)</p>
            <form
              className="server-auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleResetPassword();
              }}
            >
              <div className="form-field">
                <label htmlFor="reset-password">새 비밀번호</label>
                <input
                  id="reset-password"
                  type="password"
                  value={resetPasswordValue}
                  onChange={(event) => setResetPasswordValue(event.target.value)}
                />
              </div>
              <button className="primary-button" disabled={isServerBusy || resetPasswordValue.length < 8} type="submit">
                비밀번호 변경
              </button>
            </form>
            {serverStatus ? <p className={serverErrorKind ? "sync-status sync-status-error" : "sync-status"}>{serverStatus}</p> : null}
          </section>
        </div>
      ) : null}

      {isCategoryModalOpen ? (
        <div className="modal-backdrop" onMouseDown={() => setIsCategoryModalOpen(false)}>
          <section
            aria-labelledby="category-modal-title"
            aria-modal="true"
            className="category-modal"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="section-label">관리</p>
                <h2 id="category-modal-title">카테고리 관리</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setIsCategoryModalOpen(false)}>
                닫기
              </button>
            </div>
            <div className="category-create">
              <label htmlFor="new-category">새 카테고리</label>
              <input
                id="new-category"
                type="text"
                value={newCategoryLabel}
                onChange={(event) => setNewCategoryLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleAddCategory();
                  }
                }}
              />
              <button className="secondary-button" type="button" onClick={handleAddCategory}>
                추가
              </button>
            </div>
            <div className="category-list">
              {categories.map((category) => {
                const isDefault = isDefaultCategory(category.id);

                return (
                  <div className="category-row" key={category.id}>
                    <div>
                      <label className="sr-only" htmlFor={category.id + "-category-label"}>
                        카테고리명
                      </label>
                      <input
                        id={category.id + "-category-label"}
                        disabled={isDefault}
                        type="text"
                        value={category.label}
                        onChange={(event) => handleRenameCategory(category.id, event.target.value)}
                      />
                      <small>{category.id}</small>
                    </div>
                    <button
                      className="ghost-button"
                      disabled={isDefault}
                      type="button"
                      onClick={() => handleDeleteCategory(category.id)}
                    >
                      삭제
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {isCardModalOpen ? (
        <div className="modal-backdrop" onMouseDown={() => setIsCardModalOpen(false)}>
          <section
            aria-labelledby="card-modal-title"
            aria-modal="true"
            className="category-modal"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="section-label">관리</p>
                <h2 id="card-modal-title">카드 관리</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setIsCardModalOpen(false)}>
                닫기
              </button>
            </div>
            <div className="card-create">
              <label htmlFor="new-card">카드 이름</label>
              <label htmlFor="new-card-billing-day">결제일</label>
              <input
                id="new-card"
                type="text"
                value={newCardLabel}
                onChange={(event) => setNewCardLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleAddCard();
                  }
                }}
              />
              <input
                id="new-card-billing-day"
                max="31"
                min="1"
                type="number"
                value={newCardBillingDay}
                onChange={(event) => setNewCardBillingDay(clampBillingDay(parseCurrencyInput(event.target.value)))}
              />
              <button className="secondary-button" type="button" onClick={handleAddCard}>
                추가
              </button>
            </div>
            <div className="category-list">
              {cards.map((card) => {
                const isDefault = isDefaultCard(card.id);

                return (
                  <div className="category-row" key={card.id}>
                    <div>
                      <label className="sr-only" htmlFor={card.id + "-card-label"}>
                        카드명
                      </label>
                      <input
                        id={card.id + "-card-label"}
                        disabled={isDefault}
                        type="text"
                        value={card.label}
                        onChange={(event) => handleRenameCard(card.id, event.target.value)}
                      />
                      <small>{card.id}</small>
                    </div>
                    <div>
                      <label className="sr-only" htmlFor={card.id + "-card-billing-day"}>
                        카드 결제일
                      </label>
                      <input
                        id={card.id + "-card-billing-day"}
                        disabled={isDefault}
                        max="31"
                        min="1"
                        type="number"
                        value={card.billingDay}
                        onChange={(event) => handleUpdateCardBillingDay(card.id, parseCurrencyInput(event.target.value))}
                      />
                      <small>결제일</small>
                    </div>
                    <button
                      className="ghost-button"
                      disabled={isDefault}
                      type="button"
                      onClick={() => handleDeleteCard(card.id)}
                    >
                      삭제
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function BudgetSummaryCard({ title, summary }: { title: string; summary: BudgetSnapshotSummary }) {
  return (
    <div className="sync-summary-card">
      <span>{title}</span>
      <strong>{formatWon(summary.monthlyExpense)}</strong>
      <small>
        월 수입 {formatWon(summary.monthlyIncome)} · 항목 {summary.fixedCostCount}개 · 카테고리 {summary.categoryCount}개 · 카드 {summary.cardCount}개
      </small>
    </div>
  );
}

function parseBudgetSnapshot(stored: string | null): { snapshot: BudgetSnapshot; recovered: boolean } {
  const fallback = sampleBudgetSnapshot;

  if (!stored) {
    return { snapshot: fallback, recovered: false };
  }

  try {
    const parsed = JSON.parse(stored) as {
      monthlyIncome?: number;
      fixedCosts?: FixedCost[];
      categories?: Category[];
      cards?: PaymentCard[];
    };

    return {
      snapshot: {
      monthlyIncome: typeof parsed.monthlyIncome === "number" ? Math.max(0, Math.round(parsed.monthlyIncome)) : fallback.monthlyIncome,
      fixedCosts: Array.isArray(parsed.fixedCosts) ? parsed.fixedCosts.map((item) => createFixedCost(item)) : fallback.fixedCosts,
      categories: Array.isArray(parsed.categories) ? mergeCategories(DEFAULT_CATEGORIES, parsed.categories) : fallback.categories,
      cards: Array.isArray(parsed.cards) ? mergeCards(DEFAULT_CARDS, parsed.cards) : fallback.cards
      },
      recovered: false
    };
  } catch {
    return { snapshot: fallback, recovered: true };
  }
}

function readJson<T>(key: string, fallback: T): T {
  const stored = window.localStorage.getItem(key);
  if (!stored) {
    return fallback;
  }

  try {
    return JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
}

function getCurrentBudgetSnapshotFromState(snapshot: BudgetSnapshot): LocalBudgetSnapshot {
  return {
    monthlyIncome: snapshot.monthlyIncome,
    categories: snapshot.categories,
    cards: snapshot.cards,
    fixedCosts: snapshot.fixedCosts
  };
}

function buildSnapshotKey(snapshot: LocalBudgetSnapshot) {
  return JSON.stringify({
    monthlyIncome: Math.max(0, Math.round(snapshot.monthlyIncome)),
    categories: snapshot.categories.map((category) => ({
      id: category.id,
      label: category.label
    })),
    cards: snapshot.cards.map((card) => ({
      id: card.id,
      label: card.label,
      billingDay: card.billingDay
    })),
    fixedCosts: snapshot.fixedCosts.map((item) => ({
      id: item.id,
      name: item.name,
      categoryId: item.categoryId,
      paymentMethodId: item.paymentMethodId,
      paymentOptionId: item.paymentOptionId,
      amount: item.amount,
      periodMonths: item.periodMonths,
      billingDay: item.billingDay
    }))
  });
}

function isServerSession(value: ServerSession | null): value is ServerSession {
  return (
    !!value &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.refreshToken === "string" &&
    value.refreshToken.length > 0 &&
    typeof value.user?.id === "string" &&
    typeof value.user?.email === "string" &&
    typeof value.user?.name === "string"
  );
}

function clearAuthQueryParam(key: string) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.delete(key);
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

function getErrorMessage(error: unknown) {
  if (error instanceof ServerApiError) {
    const mapped = mapServerErrorMessage(error);
    if (mapped) {
      return mapped;
    }
  }
  return error instanceof Error ? error.message : "서버 요청에 실패했습니다.";
}

// Map server-side English/technical messages (and bare status codes) to friendly
// Korean copy so developer messages like "Invalid request body" never surface to users.
function mapServerErrorMessage(error: ServerApiError): string | null {
  if (error.status === 400) {
    return "입력값을 확인해주세요.";
  }
  if (error.status === 409) {
    return "이미 가입된 이메일입니다.";
  }
  if (error.status === 429) {
    return "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
  }
  if (error.status >= 500) {
    return "서버에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.";
  }
  return null;
}

function getServerSyncErrorMessage(error: unknown) {
  if (isServerAuthFailure(error)) {
    return "서버 세션이 만료되었거나 권한이 없습니다. 다시 로그인해 주세요.";
  }

  return getErrorMessage(error);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Client-side pre-submit validation mirroring the shared Zod schemas
// (registerRequestSchema etc.): email format, password min 8, name min 1.
// Returns a friendly Korean message, or null when the input is valid.
function validateEmail(email: string): string | null {
  if (!email.trim()) {
    return "이메일을 입력해주세요.";
  }
  if (!EMAIL_PATTERN.test(email.trim())) {
    return "올바른 이메일 형식이 아닙니다.";
  }
  return null;
}

function validatePassword(password: string): string | null {
  if (!password) {
    return "비밀번호를 입력해주세요.";
  }
  if (password.length < 8) {
    return "비밀번호는 8자 이상이어야 합니다.";
  }
  return null;
}

function validateName(name: string): string | null {
  if (!name.trim()) {
    return "이름을 입력해주세요.";
  }
  return null;
}
