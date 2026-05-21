"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  BANK_TRANSFER_OPTIONS,
  buildBudgetSummary,
  createCategory,
  createFixedCost,
  DEFAULT_CATEGORIES,
  deleteCategory,
  getCategoryBuckets,
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
import { createUser, getUserDataKey, mergeUsers, type AppUser } from "./lib/users";

const USERS_KEY = "living-cost-manager:users:v1";
const ACTIVE_USER_KEY = "living-cost-manager:active-user:v1";
const STORAGE_KEY = "living-cost-manager:v2";
const LEGACY_STORAGE_KEY = "living-cost-manager:v1";

const seedFixedCosts: FixedCost[] = [
  createFixedCost({
    id: "rent",
    name: "월세",
    categoryId: "housing",
    paymentMethodId: "bank-transfer",
    amount: 650000,
    billingDay: 25
  }),
  createFixedCost({
    id: "phone",
    name: "통신비",
    categoryId: "telecom",
    paymentMethodId: "credit-card",
    paymentOptionId: "",
    amount: 79000,
    billingDay: 10
  }),
  createFixedCost({
    id: "insurance",
    name: "보험료",
    categoryId: "insurance",
    paymentMethodId: "bank-transfer",
    amount: 155000,
    billingDay: 15
  }),
  createFixedCost({
    id: "subscription",
    name: "구독 서비스",
    categoryId: "subscription",
    paymentMethodId: "credit-card",
    paymentOptionId: "",
    amount: 35000,
    billingDay: 5
  }),
  createFixedCost({
    id: "transport",
    name: "교통 정기권",
    categoryId: "transport",
    paymentMethodId: "debit-card",
    amount: 120000,
    billingDay: 1
  })
];

function formatWon(amount: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0
  }).format(amount);
}

export default function Home() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [knownUsers, setKnownUsers] = useState<AppUser[]>([]);
  const [loginName, setLoginName] = useState("");
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
  const [chartMode, setChartMode] = useState<"bar" | "pie">("bar");
  const [activePieSegment, setActivePieSegment] = useState<CategoryPieSegment | null>(null);
  const [pieTooltipPosition, setPieTooltipPosition] = useState({ x: 0, y: 0 });
  const [categoryFilterId, setCategoryFilterId] = useState("all");
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedDeleteIds, setSelectedDeleteIds] = useState<string[]>([]);
  const [importMessage, setImportMessage] = useState("");
  const [isBootLoaded, setIsBootLoaded] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const backupFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const users = readJson<AppUser[]>(USERS_KEY, []);
    const activeUserId = window.localStorage.getItem(ACTIVE_USER_KEY);
    const activeUser = users.find((user) => user.id === activeUserId) ?? null;

    setKnownUsers(users);
    setCurrentUser(activeUser);
    setIsBootLoaded(true);
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

    setMonthlyIncome(parsed.monthlyIncome);
    setCategories(parsed.categories);
    setCards(parsed.cards);
    setFixedCosts(parsed.fixedCosts);
    setIsLoaded(true);
  }, [currentUser, isBootLoaded]);

  useEffect(() => {
    if (!isBootLoaded || !isLoaded || !currentUser) {
      return;
    }

    window.localStorage.setItem(getUserDataKey(currentUser.id), JSON.stringify({ monthlyIncome, fixedCosts, categories, cards }));
  }, [cards, categories, currentUser, fixedCosts, isBootLoaded, isLoaded, monthlyIncome]);

  useEffect(() => {
    if (!isCategoryModalOpen && !isCardModalOpen && !isDataModalOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsCategoryModalOpen(false);
        setIsCardModalOpen(false);
        setIsDataModalOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCardModalOpen, isCategoryModalOpen, isDataModalOpen]);

  const summary = useMemo(() => buildBudgetSummary(fixedCosts, monthlyIncome), [fixedCosts, monthlyIncome]);
  const buckets = useMemo(() => getCategoryBuckets(fixedCosts, categories), [categories, fixedCosts]);
  const pieSegments = useMemo(() => getCategoryPieSegments(buckets), [buckets]);
  const visibleFixedCosts = useMemo(
    () => (categoryFilterId === "all" ? fixedCosts : fixedCosts.filter((item) => item.categoryId === categoryFilterId)),
    [categoryFilterId, fixedCosts]
  );
  const visibleFixedCostTotal = useMemo(
    () => visibleFixedCosts.reduce((total, item) => total + item.amount, 0),
    [visibleFixedCosts]
  );
  const progressWidth = String(Math.min(summary.expenseRate, 100)) + "%";
  const pieBackground = buildPieBackground(pieSegments);

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
    const nextUsers = mergeUsers(knownUsers, nextUser);

    window.localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
    window.localStorage.setItem(ACTIVE_USER_KEY, nextUser.id);
    setKnownUsers(nextUsers);
    setIsLoaded(false);
    setCurrentUser(nextUser);
    setLoginName("");
  }

  function handleLogout() {
    window.localStorage.removeItem(ACTIVE_USER_KEY);
    setCurrentUser(null);
    setIsCategoryModalOpen(false);
    setIsCardModalOpen(false);
    setIsDataModalOpen(false);
    setIsDeleteMode(false);
    setSelectedDeleteIds([]);
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

  if (!currentUser) {
    return (
      <main className="page-shell login-shell">
        <section className="login-card" aria-label="로그인">
          <p className="section-label">생활비 관리자</p>
          <h1>사용자별 고정지출을 확인하세요</h1>
          <p className="hero-copy">사용자 이름으로 로그인하면 각자의 수입, 고정비, 카테고리가 따로 저장됩니다.</p>
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              handleLogin(loginName);
            }}
          >
            <label htmlFor="login-name">사용자 이름</label>
            <input
              id="login-name"
              type="text"
              value={loginName}
              onChange={(event) => setLoginName(event.target.value)}
            />
            <button className="primary-button" type="submit">
              로그인
            </button>
          </form>
          {knownUsers.length > 0 ? (
            <div className="known-users" aria-label="기존 사용자">
              <span>기존 사용자</span>
              <div>
                {knownUsers.map((user) => (
                  <button className="secondary-button" key={user.id} type="button" onClick={() => handleLogin(user.name)}>
                    {user.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <header className="app-header">
        <strong>{currentUser.name}</strong>
        <button className="secondary-button" type="button" onClick={handleLogout}>
          로그아웃
        </button>
      </header>
      <section className="hero">
        <div>
          <p className="section-label">고정비 대시보드</p>
          <h1>생활비 고정비를 한 화면에서 정리하세요</h1>
          <p className="hero-copy">
            월마다 반복되는 지출을 항목, 납부일, 결제수단별로 모아 보고 예산 압박이 큰 영역을 바로 확인합니다.
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
          <p>수입 대비 고정비 {summary.expenseRate}%</p>
          <div className="income-progress" aria-label="수입 대비 고정비 비율">
            <div className="income-progress-fill" style={{ width: progressWidth }} />
          </div>
        </div>
      </section>

      <section className="metric-grid" aria-label="핵심 지표">
        <article>
          <span>이번 달 고정비</span>
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
          <small>{summary.highestCost ? formatWon(summary.highestCost.amount) : "항목을 추가하세요"}</small>
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
            <strong>{formatWon(visibleFixedCostTotal)}</strong>
          </div>
          <div className="table" role="table" aria-label="고정비 목록">
            <div className={isDeleteMode ? "table-row table-head delete-mode" : "table-row table-head"} role="row">
              <span>항목</span>
              <span>카테고리</span>
              <span>결제수단</span>
              <span>결제 옵션</span>
              <span>납부일</span>
              <span>금액</span>
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

function parseCurrencyInput(value: string) {
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function formatNumberInput(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 0
  }).format(value);
}

function clampBillingDay(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(31, Math.max(1, Math.round(value)));
}

function mergeCategories(baseCategories: Category[], incomingCategories: Category[]) {
  const categoryMap = new Map<string, Category>();
  for (const category of baseCategories) {
    categoryMap.set(category.id, category);
  }
  for (const category of incomingCategories) {
    categoryMap.set(category.id, category);
  }

  return Array.from(categoryMap.values());
}

function mergeCards(baseCards: PaymentCard[], incomingCards: PaymentCard[]) {
  const cardMap = new Map<string, PaymentCard>();
  for (const card of baseCards) {
    cardMap.set(card.id, card);
  }
  for (const card of incomingCards) {
    if (card.id === "main-credit-card" && card.label === "주 신용카드") {
      continue;
    }
    cardMap.set(card.id, normalizePaymentCard(card));
  }

  return Array.from(cardMap.values());
}

function getPaymentOptions(paymentMethodId: FixedCost["paymentMethodId"], cards: PaymentCard[]) {
  if (paymentMethodId === "bank-transfer") {
    return BANK_TRANSFER_OPTIONS;
  }

  if (paymentMethodId === "credit-card") {
    return cards;
  }

  return [];
}

const chartColors = ["#167761", "#235c9f", "#ad3b5f", "#d68b34", "#6d5bd0", "#4b8f8c", "#7b8794"];

function buildPieBackground(segments: ReturnType<typeof getCategoryPieSegments>) {
  if (segments.length === 0 || segments.every((segment) => segment.amount === 0)) {
    return "#eef3f8";
  }

  const stops = segments.map((segment, index) => {
    const color = chartColors[index % chartColors.length];
    return `${color} ${segment.startPercent}% ${segment.endPercent}%`;
  });

  return `conic-gradient(${stops.join(", ")})`;
}

function parseBudgetSnapshot(stored: string | null) {
  const fallback = {
    monthlyIncome: 3_000_000,
    fixedCosts: seedFixedCosts,
    categories: DEFAULT_CATEGORIES,
    cards: DEFAULT_CARDS
  };

  if (!stored) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(stored) as {
      monthlyIncome?: number;
      fixedCosts?: FixedCost[];
      categories?: Category[];
      cards?: PaymentCard[];
    };

    return {
      monthlyIncome: typeof parsed.monthlyIncome === "number" ? Math.max(0, Math.round(parsed.monthlyIncome)) : fallback.monthlyIncome,
      fixedCosts: Array.isArray(parsed.fixedCosts) ? parsed.fixedCosts.map((item) => createFixedCost(item)) : fallback.fixedCosts,
      categories: Array.isArray(parsed.categories) ? mergeCategories(DEFAULT_CATEGORIES, parsed.categories) : fallback.categories,
      cards: Array.isArray(parsed.cards) ? mergeCards(DEFAULT_CARDS, parsed.cards) : fallback.cards
    };
  } catch {
    return fallback;
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
