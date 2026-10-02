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
import { getUserDataKey } from "./users";
import { LEGACY_STORAGE_KEY, STORAGE_KEY, parseBudgetSnapshot } from "./storage";
import { seedFixedCosts } from "./seedData";
import { parseFixedCostInput } from "@living-cost-manager/shared";
import { getCurrentBudgetSnapshotFromState } from "./snapshot";
import type { LocalBudgetSnapshot } from "./snapshot";
import type { CardDraft } from "../components/modals/CardModal";
import type { UIStateApi } from "./useUIState";
import type { LocalUsersApi } from "./useLocalUsers";

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
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const backupFileRef = useRef<HTMLInputElement | null>(null);

  const { currentUser, isBootLoaded, isLoaded, setIsLoaded } = users;
  const { categoryFilterId, setCategoryFilterId, selectedDeleteIds, setIsDeleteMode, setSelectedDeleteIds, setImportMessage } = ui;

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

  // ── derived views ────────────────────────────────────────────────────
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
  const currentBudgetSnapshot = useMemo(
    () => getCurrentBudgetSnapshotFromState({ monthlyIncome, categories, cards, fixedCosts }),
    [cards, categories, fixedCosts, monthlyIncome]
  );

  // ── income & fixed-cost handlers ─────────────────────────────────────
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

  // 자연어 한 줄("넷플릭스 17000원 매달")을 파싱해 고정비를 추가한다.
  // 추출 실패한 필드는 handleAddItem 과 동일한 기본값으로 폴백한다.
  function handleQuickAdd(text: string) {
    const parsed = parseFixedCostInput(text);
    setFixedCosts((items) => [
      ...items,
      createFixedCost({
        id: "cost-" + Date.now().toString(36),
        name: parsed.name ?? "새 고정비",
        categoryId: categories[0]?.id ?? "other",
        paymentMethodId: "bank-transfer",
        paymentOptionId: "auto-transfer",
        amount: parsed.amount ?? 0,
        periodMonths: parsed.periodMonths ?? 1,
        billingDay: 1
      })
    ]);
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

    setFixedCosts((items) => items.filter((item) => !selectedDeleteIds.includes(item.id)));
    setSelectedDeleteIds([]);
    setIsDeleteMode(false);
    setImportMessage(deleteCount + "개 항목을 삭제했습니다.");
  }

  // ── categories ───────────────────────────────────────────────────────
  // The draft label is owned by CategoryModal and handed up on submit.
  function handleAddCategory(label: string) {
    const nextCategory = createCategory(label);
    setCategories((currentCategories) => mergeCategories(currentCategories, [nextCategory]));
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
    categories,
    cards,
    lastSavedAt,
    saveError,
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
    handleQuickAdd,
    handleEnterDeleteMode,
    handleCancelDeleteMode,
    handleToggleDeleteSelection,
    handleConfirmDeleteItems,
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
    handleImportTemplate,
    handleImportBackup,
    getCurrentBudgetSnapshot,
    applyBudgetSnapshot
  };
}

export type BudgetDataApi = ReturnType<typeof useBudgetData>;
