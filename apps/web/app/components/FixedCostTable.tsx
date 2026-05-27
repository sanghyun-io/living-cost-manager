import { getMonthlyEquivalentAmount, PAYMENT_METHODS, type Category, type FixedCost } from "../lib/budget";
import type { PaymentCard } from "../lib/cards";
import { formatNumberInput, formatWon, getPaymentOptions, parseCurrencyInput, parsePeriodInput } from "../lib/formatting";

interface FixedCostTableProps {
  categories: Category[];
  cards: PaymentCard[];
  visibleFixedCosts: FixedCost[];
  visibleFixedCostTotal: number;
  categoryFilterId: string;
  isDeleteMode: boolean;
  selectedDeleteIds: string[];
  importMessage: string;
  onItemChange: (id: string, patch: Partial<Omit<FixedCost, "id">>) => void;
  onPaymentMethodChange: (item: FixedCost, methodId: FixedCost["paymentMethodId"]) => void;
  onPaymentOptionChange: (item: FixedCost, optionId: string) => void;
  onAddItem: () => void;
  onEnterDeleteMode: () => void;
  onCancelDeleteMode: () => void;
  onConfirmDeleteItems: () => void;
  onToggleDeleteSelection: (id: string) => void;
  onFilterChange: (categoryId: string) => void;
  onOpenCategory: () => void;
  onOpenCard: () => void;
  onOpenData: () => void;
}

export function FixedCostTable({
  categories,
  cards,
  visibleFixedCosts,
  visibleFixedCostTotal,
  categoryFilterId,
  isDeleteMode,
  selectedDeleteIds,
  importMessage,
  onItemChange,
  onPaymentMethodChange,
  onPaymentOptionChange,
  onAddItem,
  onEnterDeleteMode,
  onCancelDeleteMode,
  onConfirmDeleteItems,
  onToggleDeleteSelection,
  onFilterChange,
  onOpenCategory,
  onOpenCard,
  onOpenData
}: FixedCostTableProps) {
  return (
    <div className="cost-list">
      <div className="section-heading">
        <div>
          <p className="section-label">납부 일정</p>
          <h2>고정비 항목</h2>
        </div>
        {isDeleteMode ? (
          <div className="action-group delete-actions">
            <span className="selection-count">{selectedDeleteIds.length}개 선택</span>
            <button className="secondary-button" type="button" onClick={onCancelDeleteMode}>
              취소
            </button>
            <button className="danger-button" type="button" onClick={onConfirmDeleteItems}>
              선택 삭제
            </button>
          </div>
        ) : (
          <div className="action-group">
            <button className="secondary-button" type="button" onClick={onOpenCategory}>
              카테고리 관리
            </button>
            <button className="secondary-button" type="button" onClick={onOpenCard}>
              카드 관리
            </button>
            <button className="secondary-button" type="button" onClick={onOpenData}>
              데이터 관리
            </button>
            <button className="warning-button" type="button" onClick={onEnterDeleteMode}>
              삭제 모드
            </button>
            <button className="primary-button" type="button" onClick={onAddItem}>
              항목 추가
            </button>
          </div>
        )}
      </div>
      {importMessage ? <p className="import-status">{importMessage}</p> : null}
      <div className="filter-bar" aria-label="카테고리 필터">
        <label htmlFor="category-filter">카테고리 보기</label>
        <select id="category-filter" value={categoryFilterId} onChange={(event) => onFilterChange(event.target.value)}>
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
                onChange={(event) => onItemChange(item.id, { name: event.target.value })}
              />
            </span>
            <span>
              <label className="sr-only" htmlFor={item.id + "-category"}>
                카테고리
              </label>
              <select
                id={item.id + "-category"}
                value={item.categoryId}
                onChange={(event) => onItemChange(item.id, { categoryId: event.target.value })}
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
                onChange={(event) => onPaymentMethodChange(item, event.target.value as FixedCost["paymentMethodId"])}
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
                onChange={(event) => onPaymentOptionChange(item, event.target.value)}
                disabled={getPaymentOptions(item.paymentMethodId, cards).length === 0}
              >
                {getPaymentOptions(item.paymentMethodId, cards).length === 0 ? <option value=""></option> : null}
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
                onChange={(event) => onItemChange(item.id, { billingDay: parseCurrencyInput(event.target.value) })}
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
                onChange={(event) => onItemChange(item.id, { amount: parseCurrencyInput(event.target.value) })}
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
                onChange={(event) => onItemChange(item.id, { periodMonths: parsePeriodInput(event.target.value) })}
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
                    onChange={() => onToggleDeleteSelection(item.id)}
                  />
                  <span className="sr-only">삭제 선택</span>
                </label>
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
