"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ledgerProfileId, migrateLedgerCache, recordUnselectedLedger } from './ledgerStorage';
import type { ServerSession } from './serverApi';
import {
  buildBudgetSummary,
  createCategory,
  createFixedCost,
  DEFAULT_CATEGORIES,
  deleteCategory,
  getCategoryBuckets,
  getCategoryPieSegments,
  getMonthlyEquivalentAmount,
  renameCategory,
  updateFixedCost,
  type Category,
  type FixedCost
} from "./budget";
import {
  createPaymentCard,
  DEFAULT_CARDS,
  deletePaymentCard,
  renamePaymentCard,
  updatePaymentCard,
  type PaymentCard
} from "./cards";
import { buildFixedCostCsvTemplate, parseFixedCostCsvTemplate } from "./budgetImportExport";
import { buildLivingCostBackup, parseLivingCostBackup } from "./backup";
import { buildPieBackground, clampBillingDay, mergeCards, mergeCategories } from "./formatting";
import { createGuestUser, getUserDataKey, getUserErasureKey } from "./users";
import { LEGACY_STORAGE_KEY, STORAGE_KEY, parseBudgetSnapshot } from "./storage";
import { seedFixedCosts, emptyBudgetSnapshot } from "./seedData";
import { previewQuickAdd } from "./quickAdd";
import { getCurrentBudgetSnapshotFromState } from "./snapshot";
import { track } from "./analytics";
import type { LocalBudgetSnapshot } from "./snapshot";
import type { CardDraft } from "../components/modals/CardModal";
import type { UIStateApi } from "./useUIState";
import type { LocalUsersApi } from "./useLocalUsers";
import { duplicateCost, emptyCostFilters, filterCosts } from "./costViews";
import { newestImportRecovery, saveRecovery } from "./recoveryStorage";
import { classifyItemChangeSignals, currentMarketingScope, isPendingSignalSatisfied, sendMarketingEvent, type PendingMarketingSignal, type MarketingEventName } from "./marketing";

interface UseBudgetDataOptions {
  users: LocalUsersApi;
  ui: UIStateApi;
  marketingPersonal?: boolean;
  session?: ServerSession | null;
}

/**
 * The editable budget state (income / fixed costs / categories / cards), the
 * per-user localStorage load & save, every CRUD handler, and the derived
 * summaries the dashboard renders.
 */
export function useBudgetData({ users: accountUsers, ui, marketingPersonal = false, session = null }: UseBudgetDataOptions) {
  marketingPersonal = marketingPersonal && !accountUsers.currentUser?.serverUserId;
  const currentLedgerUser = useMemo(() => session?.workspace && accountUsers.currentUser?.serverUserId === session.user.id
    ? { ...accountUsers.currentUser, id: ledgerProfileId(session.user.id, session.workspace.id), name: session.workspace.name }
    : accountUsers.currentUser?.serverUserId ? createGuestUser() : accountUsers.currentUser, [accountUsers.currentUser, session?.user.id, session?.workspace?.id]);
  const users = { ...accountUsers, currentUser: currentLedgerUser };
  const storedValue = useRef<string | null>(null);
  const freshLedgerCache = useRef<{ id: string; initial: string } | null>(null);
  const pendingMarketing = useRef<PendingMarketingSignal[]>([]);
  const [monthlyIncome, setMonthlyIncome] = useState(3_000_000);
  const [fixedCosts, setFixedCosts] = useState<FixedCost[]>(seedFixedCosts);
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [cards, setCards] = useState<PaymentCard[]>(DEFAULT_CARDS);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState("");
  const [erasedScope, setErasedScope] = useState<string | null>(null);
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [costFilters, setCostFilters] = useState(emptyCostFilters);
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [deletedBatch, setDeletedBatch] = useState<{ userId: string; items: FixedCost[] } | null>(null);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [blockedSaveUserId, setBlockedSaveUserId] = useState<string | null>(null);
  const activeUserRef = useRef<string | null>(null);
  const importEpoch = useRef(0);
  const importReadId = useRef(0);
  const appliedImportEpoch = useRef<number | null>(null);
  const loadedScopeRef = useRef<string | null>(null);
  const importedWrite = useRef<{ userId: string; value: string } | null>(null);
  loadedScopeRef.current = users.isLoaded ? loadedUserId : null;
  if (activeUserRef.current !== (users.currentUser?.id ?? null)) importEpoch.current += 1;
  activeUserRef.current = users.currentUser?.id ?? null;
  const [pendingImport, setPendingImport] = useState<{ userId: string; before: string; storedBefore: string | null; epoch: number; snapshot: LocalBudgetSnapshot } | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const backupFileRef = useRef<HTMLInputElement | null>(null);

  const { currentUser, isBootLoaded, isLoaded, setIsLoaded } = users;
  const { categoryFilterId, setCategoryFilterId, selectedDeleteIds, setIsDeleteMode, setSelectedDeleteIds, setImportMessage } = ui;

  function queueMarketing(event: MarketingEventName, itemId: string, value: string | null = null) {
    const scope = currentMarketingScope();
    if (!scope || !marketingPersonal || users.isSampleMode || !currentUser || currentUser.serverUserId || !isLoaded || loadedUserId !== currentUser.id || blockedSaveUserId === currentUser.id) return;
    if (pendingMarketing.current.length < 24) pendingMarketing.current.push({ event, itemId, value, scope, profileId: currentUser.id });
  }

  useEffect(() => {
    if (!currentUser) return;
    const erase = (event?: StorageEvent) => {
      if (!window.localStorage.getItem(getUserErasureKey(currentUser.id))) {
        if (event?.key === getUserDataKey(currentUser.id) && event.newValue !== storedValue.current) {
          setBlockedSaveUserId(currentUser.id);
          setSaveError('다른 탭에서 이 가계부를 변경했습니다. 현재 내용을 백업하고 새로고침하세요.');
        }
        return;
      }
      applyBudgetSnapshot(emptyBudgetSnapshot);
      setErasedScope(currentUser.id);
      setBlockedSaveUserId(currentUser.id);
      setSaveError("다른 탭에서 계정이 삭제되어 저장과 동기화를 중단했습니다.");
    };
    window.addEventListener("storage", erase);
    erase();
    return () => window.removeEventListener("storage", erase);
  }, [currentUser?.id]);

  // ── per-user localStorage load / save ────────────────────────────────
  useEffect(() => {
    pendingMarketing.current = [];
    if (!isBootLoaded) {
      return;
    }

    if (!currentUser) {
      setIsLoaded(true);
      return;
    }

    setIsLoaded(false);
    setDeletedBatch(null);
    if (!session && loadedUserId?.startsWith('ledger:') && loadedUserId !== currentUser.id && !window.localStorage.getItem(getUserErasureKey(loadedUserId))) {
      // Auth can be invalidated independently of an explicit exit click. Save
      // that outgoing scope before loading a guest, including an edit batched
      // with the auth failure. Refuse cross-tab overwrite or quota failure.
      try {
        const outgoingKey = getUserDataKey(loadedUserId);
        if (window.localStorage.getItem(outgoingKey) !== storedValue.current) throw new Error('Concurrent outgoing change');
        const value = JSON.stringify(getCurrentBudgetSnapshot()); window.localStorage.setItem(outgoingKey, value);
        if (window.localStorage.getItem(outgoingKey) !== value) throw new Error('Outgoing save failed');
      } catch { setSaveError('계정 연결 해제 전 내용을 저장하지 못했습니다. 메모리 내용을 백업한 뒤 다시 열어주세요.'); return; }
    }
    if (window.localStorage.getItem(getUserErasureKey(currentUser.id))) {
      applyBudgetSnapshot(emptyBudgetSnapshot); setErasedScope(currentUser.id); setBlockedSaveUserId(currentUser.id);
      setSaveError('다른 탭에서 계정이 삭제되어 저장과 동기화를 중단했습니다.'); setLoadedUserId(currentUser.id); setIsLoaded(true); return;
    }
    try {
      if (session && !session.workspace) recordUnselectedLedger(window.localStorage, session.user.id);
      if (session?.workspace && currentUser.id.startsWith('ledger:') && accountUsers.currentUser) {
        const conflict = migrateLedgerCache(window.localStorage, session.user.id, session.workspace.id, accountUsers.currentUser.id);
        if (conflict) setImportMessage('이전 단일 가계부의 캐시와 현재 가계부 캐시가 달라 두 원본을 모두 보존했습니다. 자동으로 덮어쓰거나 업로드하지 않습니다. 이전 캐시는 기존 계정 저장 키에 남아 있습니다.');
      }
    } catch {
      setSaveError('기존 공간을 안전하게 보존하지 못해 전환을 중단했습니다. 백업을 내보내세요.');
      setBlockedSaveUserId(currentUser.id); return;
    }
    const stored = window.localStorage.getItem(getUserDataKey(currentUser.id));
    storedValue.current = stored;
    const legacyStored = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = parseBudgetSnapshot(stored ?? (currentUser.id.startsWith('ledger:') || currentUser.id.startsWith('guest:') ? JSON.stringify(emptyBudgetSnapshot) : legacyStored));
    freshLedgerCache.current = stored === null && currentUser.id.startsWith('ledger:') ? { id: currentUser.id, initial: JSON.stringify({ monthlyIncome: parsed.snapshot.monthlyIncome, categories: parsed.snapshot.categories, cards: parsed.snapshot.cards, fixedCosts: parsed.snapshot.fixedCosts }) } : null;

    let recoveryFailed = false;
    if (parsed.recovered && stored) {
      try {
        saveRecovery(window.localStorage, getUserDataKey(currentUser.id), "corrupt", stored);
      } catch {
        recoveryFailed = true;
      }
      setImportMessage("저장 데이터를 읽지 못했습니다. 원본 복구 사본을 확인하고 정상 백업을 가져오세요.");
    }

    setMonthlyIncome(parsed.snapshot.monthlyIncome);
    setCategories(parsed.snapshot.categories);
    setCards(parsed.snapshot.cards);
    setFixedCosts(parsed.snapshot.fixedCosts);
    setLastSavedAt(null);
    setBlockedSaveUserId(parsed.recovered ? currentUser.id : null);
    setSaveError(parsed.recovered ? (recoveryFailed ? "복구 사본을 저장하지 못해 원본 보호를 위해 자동 저장을 중단했습니다. 저장 공간을 확보하고 다시 불러오세요." : "저장 데이터를 읽지 못해 자동 저장을 중단했습니다. 원본을 내보내고 정상 백업을 가져오세요.") : "");
    setLoadedUserId(currentUser.id);
    setIsLoaded(true);
  }, [currentUser, isBootLoaded]);

  useEffect(() => {
    // An explicit action is eligible for this persistence attempt only. Failed,
    // blocked, replaced, or imported writes never become a future retry/backfill.
    const signals = pendingMarketing.current.splice(0);
    if (!isBootLoaded || !isLoaded || !currentUser || loadedUserId !== currentUser.id || blockedSaveUserId === currentUser.id) {
      return;
    }

    try {
      if (window.localStorage.getItem(getUserErasureKey(currentUser.id))) return;
      // Import was persisted in its event handler. Never replay that write from
      // an effect: another tab may have saved in the meantime.
      if (importedWrite.current?.userId === currentUser.id) {
        const imported = importedWrite.current;
        importedWrite.current = null;
        if (imported.value === JSON.stringify({ monthlyIncome, fixedCosts, categories, cards })) return;
      }
      if (window.localStorage.getItem(getUserDataKey(currentUser.id)) !== storedValue.current) throw new Error('Concurrent tab write');
      const value = JSON.stringify({ monthlyIncome, fixedCosts, categories, cards });
      window.localStorage.setItem(getUserDataKey(currentUser.id), value);
      storedValue.current = value;
      setLastSavedAt(new Date());
      setSaveError("");
      if (marketingPersonal && !users.isSampleMode && !currentUser.serverUserId) {
        const scope = currentMarketingScope();
        for (const signal of signals) {
          if (signal.profileId === currentUser.id && signal.scope === scope && isPendingSignalSatisfied(signal, fixedCosts)) {
            sendMarketingEvent(signal.event, { workspace: { sharedWorkspace: false } });
          }
        }
      }
    } catch {
      setSaveError("브라우저 저장 공간에 저장하지 못했습니다. 전체 백업을 먼저 내보내세요.");
    }
  }, [cards, categories, currentUser, fixedCosts, isBootLoaded, isLoaded, loadedUserId, blockedSaveUserId, monthlyIncome, saveAttempt]);

  // ── derived views ────────────────────────────────────────────────────
  const summary = useMemo(() => buildBudgetSummary(fixedCosts, monthlyIncome), [fixedCosts, monthlyIncome]);
  const buckets = useMemo(() => getCategoryBuckets(fixedCosts, categories), [categories, fixedCosts]);
  const pieSegments = useMemo(() => getCategoryPieSegments(buckets), [buckets]);
  const visibleFixedCosts = useMemo(
    () => filterCosts(categoryFilterId === "all" ? fixedCosts : fixedCosts.filter((item) => item.categoryId === categoryFilterId), costFilters),
    [categoryFilterId, fixedCosts, costFilters]
  );
  const visibleFixedCostTotal = useMemo(
    () => visibleFixedCosts.reduce((total, item) => total + (item.periodMonths > 0 ? item.amount / item.periodMonths : 0), 0),
    [visibleFixedCosts]
  );
  const pieBackground = buildPieBackground(pieSegments);
  const currentBudgetSnapshot = useMemo(
    () => getCurrentBudgetSnapshotFromState({ monthlyIncome, categories, cards, fixedCosts }),
    [cards, categories, fixedCosts, monthlyIncome]
  );
  const snapshotRef = useRef(currentBudgetSnapshot);
  if (snapshotRef.current !== currentBudgetSnapshot && JSON.stringify(snapshotRef.current) !== JSON.stringify(currentBudgetSnapshot)) importEpoch.current += 1;
  snapshotRef.current = currentBudgetSnapshot;

  function importStillCurrent(userId: string | null, before: string, epoch: number): boolean {
    return userId !== null && activeUserRef.current === userId && loadedScopeRef.current === userId && importEpoch.current === epoch && JSON.stringify(snapshotRef.current) === before;
  }

  function cancelImport() { importEpoch.current += 1; importReadId.current += 1; setPendingImport(null); }
  function reportDiscardedImport(userId: string | null, readId: number) {
    if (activeUserRef.current === userId && importReadId.current === readId) {
      setImportMessage("데이터가 변경되어 가져오기를 취소했습니다. 파일을 다시 선택하세요.");
    }
  }
  function applyImport() {
    if (!pendingImport) return;
    const { userId, before, epoch, snapshot } = pendingImport;
    if (appliedImportEpoch.current === epoch) return;
    if (!importStillCurrent(userId, before, epoch)) {
      cancelImport(); setImportMessage("공간 또는 데이터가 변경되어 미리보기를 취소했습니다. 파일을 다시 선택하세요."); return;
    }
    try {
      if (window.localStorage.getItem(getUserDataKey(userId)) !== pendingImport.storedBefore) {
        cancelImport(); setImportMessage("다른 탭에서 저장 데이터가 변경되어 교체하지 않았습니다. 최신 데이터를 확인하세요."); return;
      }
      preserveBeforeImport(userId, before);
      // localStorage has no cross-tab compare-and-swap. Recheck after recovery
      // and write synchronously to eliminate the deferred-effect race, without
      // claiming atomic exclusion of simultaneous writes in other processes.
      if (window.localStorage.getItem(getUserDataKey(userId)) !== pendingImport.storedBefore) {
        cancelImport(); setImportMessage("다른 탭에서 저장 데이터가 변경되어 교체하지 않았습니다. 최신 데이터를 확인하세요."); return;
      }
      const value = JSON.stringify({ monthlyIncome: snapshot.monthlyIncome, fixedCosts: snapshot.fixedCosts, categories: snapshot.categories, cards: snapshot.cards });
      window.localStorage.setItem(getUserDataKey(userId), value);
      storedValue.current = value;
      importedWrite.current = { userId, value };
      setBlockedSaveUserId(null);
      setDeletedBatch(null);
      appliedImportEpoch.current = epoch;
      applyBudgetSnapshot(snapshot);
      setLastSavedAt(new Date());
      setSaveError("");
      setImportMessage("검증한 " + snapshot.fixedCosts.length + "개 항목을 적용했습니다.");
    } catch { setImportMessage("복구 사본을 저장하지 못해 교체하지 않았습니다."); }
  }

  function preserveBeforeImport(userId: string, snapshot: string) {
    if (window.localStorage.getItem(getUserErasureKey(userId))) throw new Error("Account erased");
    // Abort replacement if storage is full: recovery is a precondition, not best effort.
    if (blockedSaveUserId === userId) {
      const original = window.localStorage.getItem(getUserDataKey(userId));
      if (original) saveRecovery(window.localStorage, getUserDataKey(userId), "corrupt", original);
    }
    saveRecovery(window.localStorage, getUserDataKey(userId), "import", buildLivingCostBackup(JSON.parse(snapshot)));
  }

  function handleExportRecovery() {
    if (!currentUser) return;
    const rawOriginal = blockedSaveUserId === currentUser.id ? window.localStorage.getItem(getUserDataKey(currentUser.id)) : null;
    const backup = rawOriginal ?? newestImportRecovery(window.localStorage, getUserDataKey(currentUser.id));
    if (!backup) { setImportMessage("이 공간에는 교체 전 복구본이 없습니다."); return; }
    const url = URL.createObjectURL(new Blob([backup], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = rawOriginal ? "living-cost-unreadable-original.json" : "living-cost-recovery.lcm";
    link.click();
    URL.revokeObjectURL(url);
    setImportMessage(rawOriginal ? "읽지 못한 원본 JSON을 그대로 내보냈습니다. 파일을 보관한 뒤 데이터를 복구하세요." : "최근 교체 전 복구본을 내보냈습니다. 데이터 관리의 전체 Import로 복원할 수 있습니다.");
  }

  // ── income & fixed-cost handlers ─────────────────────────────────────
  function handleIncomeChange(value: number) {
    importEpoch.current += 1;
    setMonthlyIncome(Math.max(0, Math.round(value)));
  }

  function handleItemChange(id: string, patch: Partial<Omit<FixedCost, "id">>) {
    importEpoch.current += 1;
    const previous = fixedCosts.find((item) => item.id === id);
    if (previous) {
      for (const signal of classifyItemChangeSignals(patch)) {
        const oldValue = signal.event === "personal_billing_date_saved" ? previous.billingAnchorDate : previous.renewalStatus;
        if (oldValue !== signal.value) queueMarketing(signal.event, id, signal.value);
      }
    }
    setFixedCosts((items) => items.map((item) => (item.id === id ? updateFixedCost(item, patch) : item)));
  }

  function handlePaymentMethodChange(item: FixedCost, paymentMethodId: FixedCost["paymentMethodId"]) {
    handleItemChange(item.id, { paymentMethodId });
  }

  function handlePaymentOptionChange(item: FixedCost, paymentOptionId: string) {
    handleItemChange(item.id, { paymentOptionId });
  }

  function handleAddItem() {
    importEpoch.current += 1;
    const nextItem = createFixedCost({
      id: "cost-" + crypto.randomUUID(),
      name: "새 고정비",
      categoryId: categories[0]?.id ?? "other",
      paymentMethodId: "bank-transfer",
      paymentOptionId: "auto-transfer",
      amount: 0,
      periodMonths: 1,
      billingDay: 1
    });
    setFixedCosts((items) => [...items, nextItem]);
    revealItem(nextItem.id);
    track({ type: "budget.fixed_cost_add", timestamp: Date.now(), data: { categoryId: nextItem.categoryId, amount: nextItem.amount } });
  }

  function handleDuplicateItem(id: string) {
    const original = fixedCosts.find((item) => item.id === id);
    if (!original) return;
    importEpoch.current += 1;
    const copy = duplicateCost(original, "cost-" + crypto.randomUUID());
    setFixedCosts((items) => [...items, copy]);
    revealItem(copy.id);
    setCategoryFilterId("all");
    setCostFilters(emptyCostFilters);
    setImportMessage(copy.name + " 항목을 복제했습니다.");
  }

  // 자연어 한 줄("넷플릭스 17000원 매달")을 파싱해 고정비를 추가한다.
  // 추출 실패한 필드는 handleAddItem 과 동일한 기본값으로 폴백한다.
  function handleQuickAdd(text: string) {
    const parsed = previewQuickAdd(text);
    if (!parsed.valid) return false;
    importEpoch.current += 1;
    const nextItem = createFixedCost({
      id: "cost-" + crypto.randomUUID(),
      name: parsed.name ?? "새 고정비",
      categoryId: categories[0]?.id ?? "other",
      paymentMethodId: "bank-transfer",
      paymentOptionId: "auto-transfer",
      amount: parsed.amount ?? 0,
      periodMonths: parsed.periodMonths ?? 1,
      billingDay: 1
    });
    setFixedCosts((items) => [...items, nextItem]);
    queueMarketing("personal_cost_saved", nextItem.id);
    revealItem(nextItem.id);
    track({ type: "budget.fixed_cost_add", timestamp: Date.now(), data: { categoryId: nextItem.categoryId, amount: nextItem.amount } });
    return true;
  }

  // ── delete mode ──────────────────────────────────────────────────────
  function revealItem(id: string) {
    setCategoryFilterId("all");
    setCostFilters(emptyCostFilters);
    setFocusItemId(id);
    setFocusRequest((request) => request + 1);
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

    // 삭제 대상의 카테고리 정보를 state 필터로 미리 뽑아 두었다가 이벤트로 남긴다
    // (업데이터 안에서 side-effect 를 내면 StrictMode 이중 실행 시 중복 추적됨).
    const removedItems = fixedCosts.filter((item) => selectedDeleteIds.includes(item.id));
    importEpoch.current += 1;
    setDeletedBatch(currentUser ? { userId: currentUser.id, items: removedItems } : null);
    setFixedCosts((items) => items.filter((item) => !selectedDeleteIds.includes(item.id)));
    setSelectedDeleteIds([]);
    setIsDeleteMode(false);
    setImportMessage(deleteCount + "개 항목을 삭제했습니다.");
    for (const item of removedItems) {
      track({ type: "budget.fixed_cost_delete", timestamp: Date.now(), data: { categoryId: item.categoryId } });
    }
  }

  // ── categories ───────────────────────────────────────────────────────
  function handleUndoDelete() {
    if (!deletedBatch || deletedBatch.userId !== activeUserRef.current || loadedUserId !== activeUserRef.current) return;
    if (window.localStorage.getItem(getUserErasureKey(deletedBatch.userId))) return;
    importEpoch.current += 1;
    const restored = deletedBatch.items.map((item) => ({ ...item,
      categoryId: categories.some((category) => category.id === item.categoryId) ? item.categoryId : categories[0]?.id ?? "other",
      paymentOptionId: item.paymentMethodId === "credit-card" && !cards.some((card) => card.id === item.paymentOptionId) ? "" : item.paymentOptionId
    }));
    setFixedCosts((items) => [...items, ...restored.filter((item) => !items.some((existing) => existing.id === item.id))]);
    setDeletedBatch(null);
    setImportMessage("최근 삭제를 취소했습니다.");
  }
  // The draft label is owned by CategoryModal and handed up on submit.
  function handleAddCategory(label: string) {
    importEpoch.current += 1;
    const nextCategory = createCategory(label);
    setCategories((currentCategories) => mergeCategories(currentCategories, [nextCategory]));
    track({ type: "budget.category_create", timestamp: Date.now(), data: {} });
  }

  function handleRenameCategory(categoryId: string, label: string) {
    importEpoch.current += 1;
    setCategories((currentCategories) => renameCategory(currentCategories, categoryId, label));
  }

  function handleDeleteCategory(categoryId: string) {
    importEpoch.current += 1;
    setCategories((currentCategories) => {
      const result = deleteCategory(currentCategories, fixedCosts, categoryId);
      setFixedCosts(result.items);
      return result.categories;
    });
    if (categoryFilterId === categoryId) {
      setCategoryFilterId("all");
    }
  }

  // ── cards ────────────────────────────────────────────────────────────
  // CardModal owns the new-card draft fields and hands them up on submit.
  function handleAddCard(draft: CardDraft) {
    importEpoch.current += 1;
    const nextCard = createPaymentCard(draft.label, draft.billingDay, draft.isEndOfMonth);
    setCards((currentCards) => mergeCards(currentCards, [nextCard]));
    track({ type: "budget.card_create", timestamp: Date.now(), data: {} });
  }

  function handleRenameCard(cardId: string, label: string) {
    importEpoch.current += 1;
    setCards((currentCards) => renamePaymentCard(currentCards, cardId, label));
  }

  function handleUpdateCardEndOfMonth(cardId: string, isEndOfMonth: boolean) {
    importEpoch.current += 1;
    setCards((currentCards) => updatePaymentCard(currentCards, cardId, { isEndOfMonth }));
    // Card settlement date is separate from a subscription merchant charge date.
  }

  function handleUpdateCardBillingDay(cardId: string, billingDay: number) {
    importEpoch.current += 1;
    const nextBillingDay = clampBillingDay(billingDay);
    setCards((currentCards) => updatePaymentCard(currentCards, cardId, { billingDay: nextBillingDay }));
  }

  function handleDeleteCard(cardId: string) {
    importEpoch.current += 1;
    setCards((currentCards) => {
      const result = deletePaymentCard(currentCards, fixedCosts, cardId);
      setFixedCosts(result.items);
      return result.cards;
    });
  }

  // ── import / export ──────────────────────────────────────────────────
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

  function handleExportLegacySource() {
    const profile = accountUsers.currentUser;
    if (!session || !profile?.serverUserId || profile.serverUserId !== session.user.id || window.localStorage.getItem(getUserErasureKey(profile.id))) return;
    const source = window.localStorage.getItem(getUserDataKey(profile.id));
    if (source === null) return;
    // Preserve the exact original (including unsynced or corrupt fields), never
    // hydrate it into the active guest/account ledger or overwrite any cache.
    const url = URL.createObjectURL(new Blob([source], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'living-cost-legacy-source.json';
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }

  async function handleImportTemplate(file: File | null) {
    if (!file) {
      return;
    }

    const importingUserId = activeUserRef.current;
    const before = JSON.stringify(snapshotRef.current);
    const epoch = ++importEpoch.current;
    const readId = ++importReadId.current;
    setPendingImport(null);
    try {
      const storedBefore = importingUserId ? window.localStorage.getItem(getUserDataKey(importingUserId)) : null;
      const csv = await file.text();
      if (!importStillCurrent(importingUserId, before, epoch)) { reportDiscardedImport(importingUserId, readId); return; }
      const result = parseFixedCostCsvTemplate({
        csv,
        categories,
        cards
      });

      setPendingImport({ userId: importingUserId!, before, storedBefore, epoch, snapshot: { ...snapshotRef.current, categories: result.categories, cards: result.cards, fixedCosts: result.fixedCosts } });
    } catch {
      if (importStillCurrent(importingUserId, before, epoch)) setImportMessage("가져오기에 실패했습니다. CSV 형식과 필수 값을 확인하세요.");
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

    const importingUserId = activeUserRef.current;
    const before = JSON.stringify(snapshotRef.current);
    const epoch = ++importEpoch.current;
    const readId = ++importReadId.current;
    setPendingImport(null);
    try {
      const storedBefore = importingUserId ? window.localStorage.getItem(getUserDataKey(importingUserId)) : null;
      const text = await file.text();
      if (!importStillCurrent(importingUserId, before, epoch)) { reportDiscardedImport(importingUserId, readId); return; }
      const result = parseLivingCostBackup(text);
      setPendingImport({ userId: importingUserId!, before, storedBefore, epoch, snapshot: result });
    } catch {
      if (importStillCurrent(importingUserId, before, epoch)) setImportMessage("전체 백업 가져오기에 실패했습니다. 파일 형식과 내용을 확인하세요.");
    } finally {
      if (backupFileRef.current) {
        backupFileRef.current.value = "";
      }
    }
  }

  // ── snapshot plumbing (used by the server-sync hook too) ─────────────
  function getCurrentBudgetSnapshot(): LocalBudgetSnapshot {
    return {
      monthlyIncome,
      categories,
      cards,
      fixedCosts
    };
  }

  function saveBeforeSwitch(): boolean {
    if (!currentUser || loadedUserId !== currentUser.id || !isLoaded || blockedSaveUserId === currentUser.id || saveError) return false;
    try {
      const key = getUserDataKey(currentUser.id);
      if (window.localStorage.getItem(getUserErasureKey(currentUser.id)) || window.localStorage.getItem(key) !== storedValue.current) throw new Error('Scope changed');
      const value = JSON.stringify(getCurrentBudgetSnapshot());
      window.localStorage.setItem(key, value);
      if (window.localStorage.getItem(key) !== value) throw new Error('Save failed');
      storedValue.current = value;
      cancelImport();
      ui.closeDataAndManagementModals(); setIsDeleteMode(false); setSelectedDeleteIds([]); setCategoryFilterId('all'); setCostFilters(emptyCostFilters);
      return true;
    } catch { setSaveError('다른 탭의 변경 또는 저장 실패로 전환을 중단했습니다. 현재 내용을 백업하세요.'); return false; }
  }

  /** A never-before-cached ledger may initialize from its server snapshot.
   * Existing caches (even empty/unsynced ones) ALWAYS require explicit pull.
   * Refuse if the user or another tab edited during the request. */
  function initializeFreshLedger(snapshot: LocalBudgetSnapshot): boolean {
    const fresh = freshLedgerCache.current;
    if (!fresh || fresh.id !== currentUser?.id || loadedUserId !== fresh.id || !isLoaded || saveError || JSON.stringify(getCurrentBudgetSnapshot()) !== fresh.initial) return false;
    if (window.localStorage.getItem(getUserErasureKey(fresh.id)) || window.localStorage.getItem(getUserDataKey(fresh.id)) !== storedValue.current) return false;
    freshLedgerCache.current = null;
    applyBudgetSnapshot(snapshot);
    return true;
  }

  function applyBudgetSnapshot(snapshot: LocalBudgetSnapshot) {
    pendingMarketing.current = [];
    cancelImport();
    setDeletedBatch(null);
    setMonthlyIncome(snapshot.monthlyIncome);
    setCategories(snapshot.categories);
    setCards(snapshot.cards);
    setFixedCosts(snapshot.fixedCosts);
    setCategoryFilterId("all");
    setIsDeleteMode(false);
    setSelectedDeleteIds([]);
  }

  return {
    profileName: currentUser?.name,
    handleExportLegacySource,
    saveBeforeSwitch,
    initializeFreshLedger,
    monthlyIncome,
    fixedCosts,
    focusItemId,
    focusRequest,
    costFilters,
    setCostFilters,
    resetCostFilters: () => { setCostFilters(emptyCostFilters); setCategoryFilterId("all"); },
    categories,
    cards,
    lastSavedAt,
    saveError,
    pendingImport: pendingImport?.userId === currentUser?.id ? pendingImport : null,
    applyImport,
    cancelImport,
    retrySave: () => setSaveAttempt((attempt) => attempt + 1),
    localScopeKey: loadedUserId === currentUser?.id && isLoaded && erasedScope !== currentUser?.id ? loadedUserId : null,
    localRecoveryRequired: blockedSaveUserId === currentUser?.id,
    importFileRef,
    backupFileRef,
    // derived
    summary,
    buckets,
    pieSegments,
    pieBackground,
    visibleFixedCosts,
    visibleFixedCostTotal,
    currentBudgetSnapshot,
    // handlers
    handleIncomeChange,
    handleItemChange,
    handlePaymentMethodChange,
    handlePaymentOptionChange,
    handleAddItem,
    handleDuplicateItem,
    revealItem,
    handleQuickAdd,
    handleEnterDeleteMode,
    handleCancelDeleteMode,
    handleToggleDeleteSelection,
    handleConfirmDeleteItems,
    handleUndoDelete,
    canUndoDelete: !!deletedBatch && deletedBatch.userId === currentUser?.id,
    handleAddCategory,
    handleRenameCategory,
    handleDeleteCategory,
    handleAddCard,
    handleRenameCard,
    handleUpdateCardEndOfMonth,
    handleUpdateCardBillingDay,
    handleDeleteCard,
    handleExportTemplate,
    handleExportBackup,
    handleExportRecovery,
    handleImportTemplate,
    handleImportBackup,
    getCurrentBudgetSnapshot,
    applyBudgetSnapshot
  };
}

export type BudgetDataApi = ReturnType<typeof useBudgetData>;
