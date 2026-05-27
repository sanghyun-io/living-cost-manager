"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { InvitationRole, WorkspaceDto, WorkspaceInvitationDto, WorkspaceMemberDto, WorkspaceSnapshot } from "@living-cost-manager/shared";
import {
  buildBudgetSummary,
  createCategory,
  createFixedCost,
  DEFAULT_CATEGORIES,
  deleteCategory,
  getCategoryBuckets,
  getMonthlyEquivalentAmount,
  getCategoryPieSegments,
  getPieSegmentAtPercent,
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
import { canManageSharing, canSyncWorkspace, findCurrentMember } from "./lib/sharing";
import {
  getAccountSyncState,
  getSyncStateView,
  summarizeBudgetSnapshot,
  type AccountSyncState
} from "./lib/syncStatus";
import {
  buildPieBackground,
  clampBillingDay,
  mergeCards,
  mergeCategories,
  parseCurrencyInput
} from "./lib/formatting";
import type { BudgetSnapshot } from "./lib/pageTypes";
import { emptyBudgetSnapshot, sampleBudgetSnapshot, seedFixedCosts } from "./lib/seedData";
import { AppHeader } from "./components/AppHeader";
import { HeroPanel } from "./components/HeroPanel";
import { MetricGrid } from "./components/MetricGrid";
import { ChartSection } from "./components/ChartSection";
import { FixedCostTable } from "./components/FixedCostTable";
import { CategoryModal } from "./components/modals/CategoryModal";
import { CardModal } from "./components/modals/CardModal";
import { AuthModal } from "./components/modals/AuthModal";
import { ResetPasswordModal } from "./components/modals/ResetPasswordModal";
import { DataModal } from "./components/modals/DataModal";

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
  const [newCardIsEndOfMonth, setNewCardIsEndOfMonth] = useState(false);
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
  // Track which auth fields the user has left (blurred) so we only surface
  // validation errors after they finish typing a field, not while typing.
  // Name is optional (falls back to email), so it has no validation entry.
  const [authTouched, setAuthTouched] = useState<{ email: boolean; password: boolean }>({
    email: false,
    password: false,
  });
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

  function handleIncomeChange(value: number) {
    setMonthlyIncome(Math.max(0, Math.round(value)));
  }

  function handleItemChange(id: string, patch: Partial<Omit<FixedCost, "id">>) {
    setFixedCosts((items) => items.map((item) => (item.id === id ? updateFixedCost(item, patch) : item)));
  }

  function handlePaymentMethodChange(item: FixedCost, paymentMethodId: FixedCost["paymentMethodId"]) {
    const selectedCard = paymentMethodId === "credit-card" ? cards.find((card) => card.id === item.paymentOptionId) : null;
    handleItemChange(item.id, {
      paymentMethodId,
      billingDay: selectedCard?.billingDay ?? item.billingDay,
      isEndOfMonth: selectedCard?.isEndOfMonth ?? item.isEndOfMonth
    });
  }

  function handlePaymentOptionChange(item: FixedCost, paymentOptionId: string) {
    const selectedCard = item.paymentMethodId === "credit-card" ? cards.find((card) => card.id === paymentOptionId) : null;
    handleItemChange(item.id, {
      paymentOptionId,
      billingDay: selectedCard?.billingDay ?? item.billingDay,
      isEndOfMonth: selectedCard?.isEndOfMonth ?? item.isEndOfMonth
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
    const nextCard = createPaymentCard(newCardLabel, newCardBillingDay, newCardIsEndOfMonth);
    setCards((currentCards) => mergeCards(currentCards, [nextCard]));
    setNewCardLabel("");
    setNewCardBillingDay(1);
    setNewCardIsEndOfMonth(false);
  }

  function handleRenameCard(cardId: string, label: string) {
    setCards((currentCards) => renamePaymentCard(currentCards, cardId, label));
  }

  function handleUpdateCardEndOfMonth(cardId: string, isEndOfMonth: boolean) {
    setCards((currentCards) => updatePaymentCard(currentCards, cardId, { isEndOfMonth }));
    // Propagate to fixed costs paying via this card so their billing date stays in sync.
    setFixedCosts((items) =>
      items.map((item) =>
        item.paymentMethodId === "credit-card" && item.paymentOptionId === cardId
          ? updateFixedCost(item, { isEndOfMonth })
          : item
      )
    );
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

  // Auth form validation. Rules mirror the shared Zod schema
  // (registerRequestSchema / loginRequestSchema): valid email format and
  // a password of at least 8 characters. Errors are only shown for fields the
  // user has already blurred (see authTouched) so we don't nag while typing.
  const trimmedAuthEmail = serverEmail.trim();
  const authEmailError =
    trimmedAuthEmail.length === 0
      ? "이메일을 입력해 주세요."
      : !EMAIL_PATTERN.test(trimmedAuthEmail)
        ? "올바른 이메일 형식이 아닙니다."
        : null;
  const authPasswordError =
    serverPassword.length === 0
      ? "비밀번호를 입력해 주세요."
      : serverPassword.length < 8
        ? "비밀번호는 8자 이상이어야 합니다."
        : null;
  // Name is optional at submit time (falls back to email), so it never blocks.
  const isAuthFormValid = !authEmailError && !authPasswordError;

  function markAuthFieldTouched(field: "email" | "password") {
    setAuthTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }

  function resetAuthTouched() {
    setAuthTouched({ email: false, password: false });
  }

  async function handleServerAuthSubmit() {
    if (!serverApi) {
      setServerStatus("서버 API URL이 없어 로컬 전용으로 동작합니다.");
      return;
    }
    // Guard against programmatic/Enter submits when the form is invalid, and
    // reveal any outstanding errors by marking the relevant fields touched.
    if (!isAuthFormValid) {
      setAuthTouched({ email: true, password: true });
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
      <AppHeader
        saveError={saveError}
        lastSavedAt={lastSavedAt}
        serverSession={serverSession}
        currentUserName={currentUser?.name}
        onOpenData={() => setIsDataModalOpen(true)}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        onServerLogout={() => {
          handleServerLogout();
          handleLogout();
        }}
      />
      <HeroPanel
        monthlyIncome={monthlyIncome}
        expenseRate={summary.expenseRate}
        hasServerWorkspace={Boolean(serverSession?.workspace)}
        onIncomeChange={handleIncomeChange}
      />

      <MetricGrid summary={summary} fixedCostCount={fixedCosts.length} />

      <section className="workspace">
        <FixedCostTable
          categories={categories}
          cards={cards}
          visibleFixedCosts={visibleFixedCosts}
          visibleFixedCostTotal={visibleFixedCostTotal}
          categoryFilterId={categoryFilterId}
          isDeleteMode={isDeleteMode}
          selectedDeleteIds={selectedDeleteIds}
          importMessage={importMessage}
          onItemChange={handleItemChange}
          onPaymentMethodChange={handlePaymentMethodChange}
          onPaymentOptionChange={handlePaymentOptionChange}
          onAddItem={handleAddItem}
          onEnterDeleteMode={handleEnterDeleteMode}
          onCancelDeleteMode={handleCancelDeleteMode}
          onConfirmDeleteItems={handleConfirmDeleteItems}
          onToggleDeleteSelection={handleToggleDeleteSelection}
          onFilterChange={(categoryId) => {
            setCategoryFilterId(categoryId);
            setSelectedDeleteIds([]);
          }}
          onOpenCategory={() => setIsCategoryModalOpen(true)}
          onOpenCard={() => setIsCardModalOpen(true)}
          onOpenData={() => setIsDataModalOpen(true)}
        />

        <ChartSection
          chartMode={chartMode}
          buckets={buckets}
          pieSegments={pieSegments}
          monthlyExpense={summary.monthlyExpense}
          pieBackground={pieBackground}
          activePieSegment={activePieSegment}
          pieTooltipPosition={pieTooltipPosition}
          onChartModeChange={setChartMode}
          onPieMove={handlePieMove}
          onPieLeave={() => setActivePieSegment(null)}
        />
      </section>

      <DataModal
          opened={isDataModalOpen}
          hasServerApi={Boolean(serverApi)}
          importFileRef={importFileRef}
          backupFileRef={backupFileRef}
          onClose={() => setIsDataModalOpen(false)}
          onExportTemplate={handleExportTemplate}
          onImportTemplate={(file) => void handleImportTemplate(file)}
          onExportBackup={handleExportBackup}
          onImportBackup={(file) => void handleImportBackup(file)}
          sync={{
            serverSession,
            syncStateView,
            displayedSyncState,
            lastServerSyncedAt,
            localSnapshotSummary,
            serverSnapshotSummary,
            serverSnapshot,
            serverWorkspaces,
            currentWorkspaceRole,
            canUploadServerSnapshot,
            isServerBusy,
            serverStatus,
            serverErrorKind,
            changeCurrentPassword,
            changeNewPassword,
            showUploadButton: Boolean(
              serverSnapshot && isWorkspaceSnapshotEmpty(serverSnapshot) && hasLocalBudgetData(getCurrentBudgetSnapshot())
            ),
            showLoadButton: Boolean(serverSnapshot && !isWorkspaceSnapshotEmpty(serverSnapshot)),
            onServerLogout: handleServerLogout,
            onResendVerification: () => void handleResendVerification(),
            onChangePassword: () => void handleChangePassword(),
            onChangeCurrentPassword: setChangeCurrentPassword,
            onChangeNewPassword: setChangeNewPassword,
            onSelectWorkspace: (workspaceId) => void handleSelectServerWorkspace(workspaceId),
            onCheckServer: () => {
              if (serverSession) {
                void prepareServerSyncDecision(serverSession);
              }
            },
            onSyncNow: () => void handleSyncNow(),
            onLoadSnapshot: () => void handleLoadServerSnapshot(),
            onStayLocal: handleStayLocalOnly,
            onOpenAuth: () => {
              setIsDataModalOpen(false);
              setIsAuthModalOpen(true);
            },
            onExportBackup: handleExportBackup
          }}
          sharing={{
            serverSession,
            members,
            invitations,
            acceptTokens,
            inviteEmail,
            inviteRole,
            visibleCreatedInvitation,
            canManageCurrentWorkspace,
            isServerBusy,
            onAcceptTokenChange: (invitationId, value) =>
              setAcceptTokens((tokens) => ({ ...tokens, [invitationId]: value })),
            onAcceptInvitation: (invitationId) => void handleAcceptInvitation(invitationId),
            onRefreshSharing: () => void refreshSharing(),
            onCreateInvitation: () => void handleCreateInvitation(),
            onInviteEmailChange: setInviteEmail,
            onInviteRoleChange: setInviteRole,
            onUpdateMemberRole: (memberId, role) => void handleUpdateMemberRole(memberId, role),
            onDeleteMember: (memberId) => void handleDeleteMember(memberId)
          }}
        />

      <AuthModal
          opened={isAuthModalOpen}
          hasServerApi={Boolean(serverApi)}
          authView={authView}
          serverAuthMode={serverAuthMode}
          serverEmail={serverEmail}
          serverPassword={serverPassword}
          serverName={serverName}
          isServerBusy={isServerBusy}
          serverStatus={serverStatus}
          serverErrorKind={serverErrorKind}
          authTouched={authTouched}
          authEmailError={authEmailError}
          authPasswordError={authPasswordError}
          isAuthFormValid={isAuthFormValid}
          onEmailChange={setServerEmail}
          onPasswordChange={setServerPassword}
          onNameChange={setServerName}
          onBlurField={markAuthFieldTouched}
          onModeChange={(mode) => {
            setServerAuthMode(mode);
            resetAuthTouched();
          }}
          onViewChange={(view) => {
            setAuthView(view);
            if (view === "forgot") {
              setServerStatus("");
            }
          }}
          onSubmit={() => void handleServerAuthSubmit()}
          onForgotSubmit={() => void handleForgotPassword()}
          onClose={() => setIsAuthModalOpen(false)}
        />

      <ResetPasswordModal
          opened={resetToken !== null}
          resetPasswordValue={resetPasswordValue}
          isServerBusy={isServerBusy}
          serverStatus={serverStatus}
          serverErrorKind={serverErrorKind}
          onPasswordChange={setResetPasswordValue}
          onSubmit={() => void handleResetPassword()}
          onClose={() => {
            setResetToken(null);
            clearAuthQueryParam("reset_token");
          }}
        />

      <CategoryModal
          opened={isCategoryModalOpen}
          categories={categories}
          newCategoryLabel={newCategoryLabel}
          onLabelChange={setNewCategoryLabel}
          onAdd={handleAddCategory}
          onRename={handleRenameCategory}
          onDelete={handleDeleteCategory}
          onClose={() => setIsCategoryModalOpen(false)}
        />

      <CardModal
          opened={isCardModalOpen}
          cards={cards}
          newCardLabel={newCardLabel}
          newCardBillingDay={newCardBillingDay}
          newCardIsEndOfMonth={newCardIsEndOfMonth}
          onLabelChange={setNewCardLabel}
          onBillingDayChange={setNewCardBillingDay}
          onNewCardEndOfMonthChange={setNewCardIsEndOfMonth}
          onAdd={handleAddCard}
          onRename={handleRenameCard}
          onUpdateBillingDay={handleUpdateCardBillingDay}
          onUpdateEndOfMonth={handleUpdateCardEndOfMonth}
          onDelete={handleDeleteCard}
          onClose={() => setIsCardModalOpen(false)}
        />
    </main>
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
