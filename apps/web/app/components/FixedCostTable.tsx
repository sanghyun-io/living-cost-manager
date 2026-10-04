import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, NumberInput, Select, Text, TextInput, Title } from "@mantine/core";
import { suggestCategoryId, billingDateSchema } from "@living-cost-manager/shared";
import { scheduleHelp } from "../lib/scheduleHelp";
import { getMonthlyEquivalentAmount, PAYMENT_METHODS, type Category, type FixedCost } from "../lib/budget";
import type { PaymentCard } from "../lib/cards";
import type { CostFilters } from "../lib/costViews";
import { previewQuickAdd } from "../lib/quickAdd";
import { formatWon, getPaymentOptions } from "../lib/formatting";

interface FixedCostTableProps {
  focusItemId: string | null;
  focusRequest: number;
  costFilters: CostFilters;
  onCostFilters: (filters: CostFilters) => void;
  onResetFilters: () => void;
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
  onDuplicateItem: (id: string) => void;
  onQuickAdd?: (text: string) => boolean | void;
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

// Deterministic, purely decorative category dot colors (Mantine palette vars so
// both color schemes resolve correctly).
const CATEGORY_COLORS = [
  "var(--mantine-color-teal-6)",
  "var(--mantine-color-amber-6)",
  "var(--mantine-color-violet-6)",
  "var(--mantine-color-blue-6)",
  "var(--mantine-color-orange-6)",
  "var(--mantine-color-pink-6)"
];

function categoryColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length];
}

export function FixedCostTable({
  focusItemId,
  focusRequest,
  costFilters, onCostFilters, onResetFilters,
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
  onDuplicateItem,
  onQuickAdd,
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
  const [quickAddText, setQuickAddText] = useState("");
  const focusInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusItemId) { focusInput.current?.focus(); focusInput.current?.select(); }
  }, [focusItemId, focusRequest]);
  const quickPreview = previewQuickAdd(quickAddText);

  function submitQuickAdd() {
    const text = quickAddText.trim();
    if (!quickPreview.valid || !onQuickAdd) {
      return;
    }
    if (onQuickAdd(text) === false) return;
    setQuickAddText("");
  }

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
      {!isDeleteMode && onQuickAdd ? (
        <Group gap="xs" mb="sm" align="flex-end" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            label="빠른 추가"
            description="예: 넷플릭스 17000원 매달"
            placeholder="항목명과 금액, 주기를 한 줄로 입력하세요"
            value={quickAddText}
            onChange={(event) => setQuickAddText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                submitQuickAdd();
              }
            }}
          />
          <Button onClick={submitQuickAdd} disabled={!quickPreview.valid}>
            추가
          </Button>
        </Group>
      ) : null}
      <div className="filter-bar" aria-label="고정비 필터">
        {quickAddText && !isDeleteMode ? <Text role="status" size="sm">{quickPreview.valid
          ? `미리보기: ${quickPreview.name} · ${formatWon(quickPreview.amount!)} · ${quickPreview.periodMonths}개월${quickPreview.defaultPeriod ? " (주기 생략: 매월)" : ""}${!Number.isInteger(quickPreview.periodMonths) ? " · 월환산 비교에 사용하며 정확한 청구 일정은 계산하지 않습니다." : ""}`
          : "이름과 유효한 금액을 입력하세요. 입력 내용은 유지됩니다."}</Text> : null}
        <TextInput label="이름 검색" value={costFilters.query} onChange={(e) => onCostFilters({ ...costFilters, query: e.currentTarget.value })} />
        <Select label="결제수단 필터" value={costFilters.method} data={[{ value: "all", label: "모든 결제수단" }, ...methodData]} onChange={(value) => onCostFilters({ ...costFilters, method: value ?? "all" })} />
        <Select label="검토 상태 필터" value={costFilters.review} data={[{ value: "all", label: "모든 검토 상태" }, { value: "unreviewed", label: "미검토" }, { value: "keep", label: "유지" }, { value: "cancel-planned", label: "해지 예정" }, { value: "change-review", label: "변경 검토" }, { value: "completed", label: "검토 완료" }]} onChange={(value) => onCostFilters({ ...costFilters, review: value ?? "all" })} />
        <Select label="정렬" value={costFilters.sort} data={[{ value: "original", label: "등록 순서" }, { value: "amount", label: "청구 금액 큰 순" }, { value: "due", label: "다음 납부일 순 (미확인 마지막)" }]} onChange={(value) => onCostFilters({ ...costFilters, sort: value ?? "original" })} />
        <Button variant="default" onClick={onResetFilters}>필터 초기화</Button>
        <Select
          label="카테고리 보기"
          data={filterData}
          value={categoryFilterId}
          onChange={(value) => onFilterChange(value ?? "all")}
          allowDeselect={false}
          size="sm"
        />
        <Text size="sm">{visibleFixedCosts.length}개 항목</Text>
        <Text size="sm" fw={700} className="tnum">월 환산 {formatWon(visibleFixedCostTotal)}</Text>
      </div>
      <div className="table" role="group" aria-label="고정비 목록">
        <div className={isDeleteMode ? "table-row table-head delete-mode" : "table-row table-head"} aria-hidden="true">
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
        {visibleFixedCosts.length === 0 ? (
          <div className="table-empty" role="note">
            {categoryFilterId === "all" && !costFilters.query && costFilters.method === "all" && costFilters.review === "all" ? (
              <>
                <Text fw={700} mb={4}>아직 등록된 고정비가 없어요</Text>
                <Text size="sm" c="dimmed">
                  위의 <strong>빠른 추가</strong>에 “넷플릭스 17000원 매달”처럼 한 줄로 입력하거나,
                  <strong> 항목 추가</strong> 버튼으로 직접 추가해 보세요. 항목명을 적으면 카테고리를 자동으로 추천해 드려요.
                </Text>
              </>
            ) : (
              <Text size="sm" c="dimmed">조건에 맞는 항목이 없어요. 필터를 초기화해 보세요.</Text>
            )}
          </div>
        ) : null}
        {visibleFixedCosts.map((item) => {
          const options = getPaymentOptions(item.paymentMethodId, cards);
          const optionData = options.map((o) => ({ value: o.id, label: o.label }));
          // 이름 기반 카테고리 추천. 존재하는 카테고리이고 현재 선택과 다를 때만 제안한다.
          const suggestedCategoryId = suggestCategoryId(item.name, { categories });
          const suggestedCategory =
            suggestedCategoryId && suggestedCategoryId !== item.categoryId
              ? categories.find((c) => c.id === suggestedCategoryId) ?? null
              : null;
          return (
            <div className={isDeleteMode ? "table-row delete-mode" : "table-row"} role="group" aria-label={item.name} key={item.id}>
              <span>
                <TextInput
                  aria-label="항목명"
                  ref={item.id === focusItemId ? focusInput : undefined}
                  label="항목명" classNames={{ label: "stacked-field-label" }}
                  size="xs"
                  value={item.name}
                  onChange={(event) => onItemChange(item.id, { name: event.currentTarget.value })}
                />
                {!isDeleteMode ? <Button variant="subtle" size="compact-xs" aria-label={`${item.name} 복제`} onClick={() => onDuplicateItem(item.id)}>복제</Button> : null}
              </span>
              <span>
                <Group gap={6} wrap="nowrap" align="center">
                  <span
                    className="cat-dot"
                    style={{ background: categoryColor(item.categoryId) }}
                    aria-hidden
                  />
                  <Select
                    aria-label="카테고리"
                    label="카테고리" classNames={{ label: "stacked-field-label" }}
                    size="xs"
                    style={{ flex: 1 }}
                    data={categoryData}
                    value={item.categoryId}
                    onChange={(value) => onItemChange(item.id, { categoryId: value ?? item.categoryId })}
                    allowDeselect={false}
                  />
                </Group>
                {!isDeleteMode && suggestedCategory ? (
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    mt={4}
                    aria-label={`카테고리를 ${suggestedCategory.label}(으)로 변경`}
                    onClick={() => onItemChange(item.id, { categoryId: suggestedCategory.id })}
                  >
                    {suggestedCategory.label}로 변경
                  </Button>
                ) : null}
              </span>
              <span>
                <Select
                  aria-label="결제수단"
                  label="결제수단" classNames={{ label: "stacked-field-label" }}
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
                  label="결제 옵션" classNames={{ label: "stacked-field-label" }}
                  size="xs"
                  data={optionData}
                  value={item.paymentOptionId || null}
                  onChange={(value) => onPaymentOptionChange(item, value ?? "")}
                  disabled={optionData.length === 0}
                  placeholder=""
                />
              </span>
              <span>
                <TextInput
                  type="date"
                  label="기준 납부일"
                  aria-label={`${item.name} 기준 납부일`}
                  size="xs"
                  value={item.billingAnchorDate ?? ""}
                  onChange={(event) => {
                    const date = event.currentTarget.value;
                    if (!date || billingDateSchema.safeParse(date).success) onItemChange(item.id, { billingAnchorDate: date || null });
                  }}
                />
                <Text size="xs" c="dimmed">{scheduleHelp(item)}</Text>
                <Checkbox
                  aria-label="말일"
                  label="말일"
                  size="xs"
                  mt={4}
                  checked={item.isEndOfMonth}
                  onChange={(event) => onItemChange(item.id, { isEndOfMonth: event.currentTarget.checked })}
                />
              </span>
              <span>
                <NumberInput
                  aria-label="금액"
                  label="금액" classNames={{ label: "stacked-field-label" }}
                  description="매 청구 시 실제 결제 금액"
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
                  label="주기" classNames={{ label: "stacked-field-label" }}
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
                <Text fw={700} size="sm" className="tnum">{formatWon(getMonthlyEquivalentAmount(item))}</Text>
                <Text size="xs" c="dimmed">{item.periodMonths}개월 기준</Text>
                <Text size="xs" c="dimmed">월 환산은 비교용이며 실제 청구액과 다를 수 있어요.</Text>
                <Select size="xs" label="갱신 검토" value={item.renewalStatus ?? "unreviewed"}
                  allowDeselect={false}
                  data={[
                    { value: "unreviewed", label: "미검토" }, { value: "keep", label: "유지" },
                    { value: "cancel-planned", label: "해지 예정" }, { value: "change-review", label: "변경 검토" },
                    { value: "completed", label: "검토 완료" }
                  ]}
                  onChange={(value) => onItemChange(item.id, { renewalStatus: value as FixedCost["renewalStatus"] })} />
                {["cancel-planned", "change-review"].includes(item.renewalStatus ?? "") ? (
                  <NumberInput size="xs" label="예상 월 절감액" min={0} max={2147483647} allowDecimal={false}
                    value={item.potentialMonthlySavings ?? 0}
                    onChange={(value) => onItemChange(item.id, { potentialMonthlySavings: toNumber(value, 0) })} />
                ) : null}
                {item.renewalStatus === "cancel-planned" ? (
                  <Button size="compact-xs" variant="light" mt={4} onClick={() => {
                    if (window.confirm("해지가 실제로 완료되었나요? 금액을 0원으로 바꾸고 현재 월 환산액을 확정 절감으로 기록합니다.")) {
                      onItemChange(item.id, { renewalStatus: "completed", confirmedMonthlySavings: getMonthlyEquivalentAmount(item), amount: 0, billingAnchorDate: null });
                    }
                  }}>해지 완료 확인</Button>
                ) : null}
                {item.renewalStatus === "completed" ? (
                  <NumberInput size="xs" label="직접 확인한 월 절감액" description="완료만으로 청구가 중단되지 않아요. 해지·변경 후 금액과 일정을 수정하세요."
                    min={0} max={2147483647} allowDecimal={false} value={item.confirmedMonthlySavings ?? 0}
                    onChange={(value) => onItemChange(item.id, { confirmedMonthlySavings: toNumber(value, 0) })} />
                ) : null}
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
