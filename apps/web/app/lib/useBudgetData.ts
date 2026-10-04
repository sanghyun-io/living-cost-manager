"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { getUserDataKey, getUserErasureKey } from "./users";
import { LEGACY_STORAGE_KEY, STORAGE_KEY, parseBudgetSnapshot } from "./storage";
import { seedFixedCosts, emptyBudgetSnapshot } from "./seedData";
import { parseFixedCostInput } from "@living-cost-manager/shared";
import { getCurrentBudgetSnapshotFromState } from "./snapshot";
import { track } from "./analytics";
import type { LocalBudgetSnapshot } from "./snapshot";
import type { CardDraft } from "../components/modals/CardModal";
import type { UIStateApi } from "./useUIState";
import type { LocalUsersApi } from "./useLocalUsers";
import { duplicateCost, emptyCostFilters, filterCosts } from "./costViews";

interface UseBudgetDataOptions {
  users: LocalUsersApi;
  ui: UIStateApi;
}

/**
 * The editable budget state (income / fixed costs / categories / cards), the
 * per-user localStorage load & save, every CRUD handler, and the derived
 * summaries the dashboard renders.
 */
export function useBudgetData({ users, ui }: UseBudgetDataOptions) {
  const [monthlyIncome, setMonthlyIncome] = useState(3_000_000);
  const [fixedCosts, setFixedCosts] = useState<FixedCost[]>(seedFixedCosts);
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [cards, setCards] = useState<PaymentCard[]>(DEFAULT_CARDS);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [costFilters, setCostFilters] = useState(emptyCostFilters);
  const [deletedBatch, setDeletedBatch] = useState<{ userId: string; items: FixedCost[] } | null>(null);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [blockedSaveUserId, setBlockedSaveUserId] = useState<string | null>(null);
  const activeUserRef = useRef<string | null>(null);
  activeUserRef.current = users.currentUser?.id ?? null;
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const backupFileRef = useRef<HTMLInputElement | null>(null);

  const { currentUser, isBootLoaded, isLoaded, setIsLoaded } = users;
  const { categoryFilterId, setCategoryFilterId, selectedDeleteIds, setIsDeleteMode, setSelectedDeleteIds, setImportMessage } = ui;

  useEffect(() => {
    if (!currentUser) return;
    const erase = () => {
      if (!window.localStorage.getItem(getUserErasureKey(currentUser.id))) return;
      applyBudgetSnapshot(emptyBudgetSnapshot);
      setBlockedSaveUserId(currentUser.id);
      setSaveError("다른 탭에서 계정이 삭제되어 저장과 동기화를 중단했습니다.");
    };
    window.addEventListener("storage", erase);
    erase();
    return () => window.removeEventListener("storage", erase);
  }, [currentUser?.id]);

  // ── per-user localStorage load / save ────────────────────────────────
  useEffect(() => {
    if (!isBootLoaded) {
      return;
    }

    if (!currentUser) {
      setIsLoaded(true);
      return;
    }

    setIsLoaded(false);
    setDeletedBatch(null);
    const stored = window.localStorage.getItem(getUserDataKey(currentUser.id));
    const legacyStored = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = parseBudgetSnapshot(stored ?? legacyStored);

    let recoveryFailed = false;
    if (parsed.recovered && stored) {
      try {
        window.localStorage.setItem(getUserDataKey(currentUser.id) + ":corrupt:" + Date.now().toString(36), stored);
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
    if (!isBootLoaded || !isLoaded || !currentUser || loadedUserId !== currentUser.id || blockedSaveUserId === currentUser.id) {
      return;
    }

    try {
      if (window.localStorage.getItem(getUserErasureKey(currentUser.id))) return;
      window.localStorage.setItem(getUserDataKey(currentUser.id), JSON.stringify({ monthlyIncome, fixedCosts, categories, cards }));
      setLastSavedAt(new Date());
      setSaveError("");
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
    () => visibleFixedCosts.reduce((total, item) => total + getMonthlyEquivalentAmount(item), 0),
    [visibleFixedCosts]
  );
  const pieBackground = buildPieBackground(pieSegments);
  const currentBudgetSnapshot = useMemo(
    () => getCurrentBudgetSnapshotFromState({ monthlyIncome, categories, cards, fixedCosts }),
    [cards, categories, fixedCosts, monthlyIncome]
  );
  const snapshotRef = useRef(currentBudgetSnapshot);
  snapshotRef.current = currentBudgetSnapshot;

  function importStillCurrent(userId: string | null, before: string): boolean {
    return userId !== null && activeUserRef.current === userId && JSON.stringify(snapshotRef.current) === before;
  }

  function preserveBeforeImport(userId: string, snapshot: string) {
    if (window.localStorage.getItem(getUserErasureKey(userId))) throw new Error("Account erased");
    // Abort replacement if storage is full: recovery is a precondition, not best effort.
    if (blockedSaveUserId === userId) {
      const original = window.localStorage.getItem(getUserDataKey(userId));
      if (original) window.localStorage.setItem(getUserDataKey(userId) + ":corrupt:" + Date.now().toString(36), original);
    }
    window.localStorage.setItem(getUserDataKey(userId) + ":recovery:" + Date.now() + ":import", buildLivingCostBackup(JSON.parse(snapshot)));
    setBlockedSaveUserId(null);
    setDeletedBatch(null);
  }

  function handleExportRecovery() {
    if (!currentUser) return;
    const rawOriginal = blockedSaveUserId === currentUser.id ? window.localStorage.getItem(getUserDataKey(currentUser.id)) : null;
    const prefix = getUserDataKey(currentUser.id) + ":recovery:";
    const keys = Object.keys(window.localStorage).filter((key) => key.startsWith(prefix))
      .sort((a, b) => Number(b.slice(prefix.length).split(":")[0]) - Number(a.slice(prefix.length).split(":")[0]));
    const backup = rawOriginal ?? (keys[0] ? window.localStorage.getItem(keys[0]) : null);
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
    setMonthlyIncome(Math.max(0, Math.round(value)));
  }

  function handleItemChange(id: string, patch: Partial<Omit<FixedCost, "id">>) {
    setFixedCosts((items) => items.map((item) => (item.id === id ? updateFixedCost(item, patch) : item)));
  }

  function handlePaymentMethodChange(item: FixedCost, paymentMethodId: FixedCost["paymentMethodId"]) {
    handleItemChange(item.id, { paymentMethodId });
  }

  function handlePaymentOptionChange(item: FixedCost, paymentOptionId: string) {
    handleItemChange(item.id, { paymentOptionId });
  }

  function handleAddItem() {
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
    track({ type: "budget.fixed_cost_add", timestamp: Date.now(), data: { categoryId: nextItem.categoryId, amount: nextItem.amount } });
  }

  function handleDuplicateItem(id: string) {
    const original = fixedCosts.find((item) => item.id === id);
    if (!original) return;
    const copy = duplicateCost(original, "cost-" + crypto.randomUUID());
    setFixedCosts((items) => [...items, copy]);
    setCategoryFilterId("all");
    setCostFilters(emptyCostFilters);
    setImportMessage(copy.name + " 항목을 복제했습니다.");
  }

  // 자연어 한 줄("넷플릭스 17000원 매달")을 파싱해 고정비를 추가한다.
  // 추출 실패한 필드는 handleAddItem 과 동일한 기본값으로 폴백한다.
  function handleQuickAdd(text: string) {
    const parsed = parseFixedCostInput(text);
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
    track({ type: "budget.fixed_cost_add", timestamp: Date.now(), data: { categoryId: nextItem.categoryId, amount: nextItem.amount } });
  }

  // ── delete mode ──────────────────────────────────────────────────────
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
    const nextCategory = createCategory(label);
    setCategories((currentCategories) => mergeCategories(currentCategories, [nextCategory]));
    track({ type: "budget.category_create", timestamp: Date.now(), data: {} });
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

  // ── cards ────────────────────────────────────────────────────────────
  // CardModal owns the new-card draft fields and hands them up on submit.
  function handleAddCard(draft: CardDraft) {
    const nextCard = createPaymentCard(draft.label, draft.billingDay, draft.isEndOfMonth);
    setCards((currentCards) => mergeCards(currentCards, [nextCard]));
    track({ type: "budget.card_create", timestamp: Date.now(), data: {} });
  }

  function handleRenameCard(cardId: string, label: string) {
    setCards((currentCards) => renamePaymentCard(currentCards, cardId, label));
  }

  function handleUpdateCardEndOfMonth(cardId: string, isEndOfMonth: boolean) {
    setCards((currentCards) => updatePaymentCard(currentCards, cardId, { isEndOfMonth }));
    // Card settlement date is separate from a subscription merchant charge date.
  }

  function handleUpdateCardBillingDay(cardId: string, billingDay: number) {
    const nextBillingDay = clampBillingDay(billingDay);
    setCards((currentCards) => updatePaymentCard(currentCards, cardId, { billingDay: nextBillingDay }));
  }

  function handleDeleteCard(cardId: string) {
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

  async function handleImportTemplate(file: File | null) {
    if (!file) {
      return;
    }

    const importingUserId = activeUserRef.current;
    const before = JSON.stringify(snapshotRef.current);
    try {
      const csv = await file.text();
      if (!importStillCurrent(importingUserId, before)) return;
      const result = parseFixedCostCsvTemplate({
        csv,
        categories,
        cards
      });

      if (!window.confirm("현재 항목을 CSV 내용으로 교체할까요? 복구용 사본을 브라우저에 보관합니다.")) return;
      preserveBeforeImport(importingUserId!, before);

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

    const importingUserId = activeUserRef.current;
    const before = JSON.stringify(snapshotRef.current);
    try {
      const text = await file.text();
      if (!importStillCurrent(importingUserId, before)) return;
      const result = parseLivingCostBackup(text);
      if (!window.confirm("현재 데이터를 백업 파일의 내용으로 교체할까요? 복구용 사본을 브라우저에 보관합니다.")) return;
      preserveBeforeImport(importingUserId!, before);

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

  // ── snapshot plumbing (used by the server-sync hook too) ─────────────
  function getCurrentBudgetSnapshot(): LocalBudgetSnapshot {
    return {
      monthlyIncome,
      categories,
      cards,
      fixedCosts
    };
  }

  function applyBudgetSnapshot(snapshot: LocalBudgetSnapshot) {
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
    monthlyIncome,
    fixedCosts,
    costFilters,
    setCostFilters,
    resetCostFilters: () => { setCostFilters(emptyCostFilters); setCategoryFilterId("all"); },
    categories,
    cards,
    lastSavedAt,
    saveError,
    retrySave: () => setSaveAttempt((attempt) => attempt + 1),
    localScopeKey: loadedUserId === currentUser?.id && isLoaded ? loadedUserId : null,
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
