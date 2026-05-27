import { Alert, Button, Checkbox, Group, NumberInput, Select, Text, TextInput, Title } from "@mantine/core";
import { getMonthlyEquivalentAmount, PAYMENT_METHODS, type Category, type FixedCost } from "../lib/budget";
import type { PaymentCard } from "../lib/cards";
import { formatWon, getPaymentOptions } from "../lib/formatting";

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

function toNumber(value: number | string, fallback: number): number {
  return typeof value === "number" ? value : fallback;
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
  const categoryData = categories.map((c) => ({ value: c.id, label: c.label }));
  const filterData = [{ value: "all", label: "전체" }, ...categoryData];
  const methodData = PAYMENT_METHODS.map((m) => ({ value: m.id, label: m.label }));

  return (
    <div className="cost-list">
      <div className="section-heading">
        <div>
          <Text className="section-label">납부 일정</Text>
          <Title order={2}>고정비 항목</Title>
        </div>
        {isDeleteMode ? (
          <Group className="action-group delete-actions" gap="xs">
            <Text size="sm" c="dimmed">{selectedDeleteIds.length}개 선택</Text>
            <Button variant="default" onClick={onCancelDeleteMode}>
              취소
            </Button>
            <Button color="rose" onClick={onConfirmDeleteItems}>
              선택 삭제
            </Button>
          </Group>
        ) : (
          <Group className="action-group" gap="xs">
            <Button variant="default" onClick={onOpenCategory}>
              카테고리 관리
            </Button>
            <Button variant="default" onClick={onOpenCard}>
              카드 관리
            </Button>
            <Button variant="default" onClick={onOpenData}>
              데이터 관리
            </Button>
            <Button color="orange" variant="light" onClick={onEnterDeleteMode}>
              삭제 모드
            </Button>
            <Button onClick={onAddItem}>항목 추가</Button>
          </Group>
        )}
      </div>
      {importMessage ? (
        <Alert color="teal" variant="light" mb="sm">
          {importMessage}
        </Alert>
      ) : null}
      <div className="filter-bar" aria-label="카테고리 필터">
        <Select
          label="카테고리 보기"
          data={filterData}
          value={categoryFilterId}
          onChange={(value) => onFilterChange(value ?? "all")}
          allowDeselect={false}
          size="sm"
        />
        <Text size="sm">{visibleFixedCosts.length}개 항목</Text>
        <Text size="sm" fw={700}>월 환산 {formatWon(visibleFixedCostTotal)}</Text>
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
        {visibleFixedCosts.map((item) => {
          const options = getPaymentOptions(item.paymentMethodId, cards);
          const optionData = options.map((o) => ({ value: o.id, label: o.label }));
          return (
            <div className={isDeleteMode ? "table-row delete-mode" : "table-row"} role="row" key={item.id}>
              <span>
                <TextInput
                  aria-label="항목명"
                  size="xs"
                  value={item.name}
                  onChange={(event) => onItemChange(item.id, { name: event.currentTarget.value })}
                />
              </span>
              <span>
                <Select
                  aria-label="카테고리"
                  size="xs"
                  data={categoryData}
                  value={item.categoryId}
                  onChange={(value) => onItemChange(item.id, { categoryId: value ?? item.categoryId })}
                  allowDeselect={false}
                />
              </span>
              <span>
                <Select
                  aria-label="결제수단"
                  size="xs"
                  data={methodData}
                  value={item.paymentMethodId}
                  onChange={(value) => onPaymentMethodChange(item, (value ?? item.paymentMethodId) as FixedCost["paymentMethodId"])}
                  allowDeselect={false}
                />
              </span>
              <span>
                <Select
                  aria-label="결제 옵션"
                  size="xs"
                  data={optionData}
                  value={item.paymentOptionId || null}
                  onChange={(value) => onPaymentOptionChange(item, value ?? "")}
                  disabled={optionData.length === 0}
                  placeholder=""
                />
              </span>
              <span>
                <NumberInput
                  aria-label="납부일"
                  size="xs"
                  min={1}
                  max={31}
                  hideControls
                  clampBehavior="strict"
                  disabled={item.paymentMethodId === "credit-card" && item.paymentOptionId.length > 0}
                  value={item.billingDay}
                  onChange={(value) => onItemChange(item.id, { billingDay: toNumber(value, item.billingDay) })}
                />
              </span>
              <span>
                <NumberInput
                  aria-label="금액"
                  size="xs"
                  min={0}
                  thousandSeparator=","
                  allowDecimal={false}
                  allowNegative={false}
                  hideControls
                  value={item.amount}
                  onChange={(value) => onItemChange(item.id, { amount: toNumber(value, 0) })}
                />
              </span>
              <span>
                <NumberInput
                  aria-label="주기"
                  size="xs"
                  min={0}
                  max={120}
                  step={0.5}
                  decimalScale={1}
                  suffix=" 개월"
                  hideControls
                  allowNegative={false}
                  value={item.periodMonths}
                  onChange={(value) => onItemChange(item.id, { periodMonths: toNumber(value, item.periodMonths) })}
                />
              </span>
              <span className="monthly-equivalent-cell">
                <Text fw={700} size="sm">{formatWon(getMonthlyEquivalentAmount(item))}</Text>
                <Text size="xs" c="dimmed">{item.periodMonths}개월 기준</Text>
              </span>
              {isDeleteMode ? (
                <span className="delete-select-cell">
                  <Checkbox
                    aria-label="삭제 선택"
                    color="rose"
                    checked={selectedDeleteIds.includes(item.id)}
                    onChange={() => onToggleDeleteSelection(item.id)}
                  />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
