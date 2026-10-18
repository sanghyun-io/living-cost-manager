import { useMemo, useState } from "react";
import { Button, Select, Text, TextInput } from "@mantine/core";
import type { WorkspacePlanningData } from "@living-cost-manager/shared";
import type { FixedCost } from "../lib/budget";
import { formatWon } from "../lib/formatting";
import { parseKrwInput } from "../lib/planningStorage";
import { planningWeekEnd } from "@living-cost-manager/shared";
import { formatCivilDateShort } from "../lib/planningTime";
import {
  applicablePatches,
  baselineMatches,
  captureBaseline,
  monthWindowFor,
  simulateScenario,
  summarizePlanVsRecord,
  weeksForWindow,
  type CostPatch,
  type ScenarioDraft
} from "../lib/monthReview";

export interface MonthReviewActions {
  /** 재발 항목만 일괄 적용(일회성 가정은 절대 원본에 저장되지 않음). */
  applyPatches: (patches: { newIncome: number | null; costs: CostPatch[] }) => { ok: boolean; message: string };
  /** 적용 직전 원본 복구본 저장(거부 시 적용 금지). */
  saveRecoveryCopy: () => boolean;
}

interface MonthReviewPanelProps {
  planning: WorkspacePlanningData;
  fixedCosts: readonly FixedCost[];
  monthlyIncome: number;
  /** canonical scope — 스코프가 바뀌면 초안·기준은 폐기된다(자동 저장 없음). */
  scopeKey: string;
  asOf: Date;
  canEdit: boolean;
  isViewer: boolean;
  actions: MonthReviewActions;
}

const EMPTY_DRAFT: ScenarioDraft = { newIncome: null, costs: [], oneOff: 0 };

/** 월말 점검 — 사용자가 열 때만 표시(자동 팝업/알림 권한 없음). 기존 코치·차트와
 *보완이며 대시보드 카드를 복제하지 않는다. */
export function MonthReviewPanel({ planning, fixedCosts, monthlyIncome, scopeKey, asOf, canEdit, isViewer, actions }: MonthReviewPanelProps) {
  const [draft, setDraft] = useState<ScenarioDraft>(EMPTY_DRAFT);
  const [baseline, setBaseline] = useState(() => captureBaseline(scopeKey, fixedCosts, monthlyIncome));
  const [incomeDraft, setIncomeDraft] = useState("");
  const [oneOffDraft, setOneOffDraft] = useState("");
  const [costTarget, setCostTarget] = useState<string | null>(null);
  const [costAmount, setCostAmount] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  // P2-7: 현재 입력란의 유효성. 하나가라도 활성 입력이 invalid면 draft의 오래된
  // 유효값으로 적용/확정이 허용되지 않는다.
  const [fieldErrors, setFieldErrors] = useState<{ income?: string; oneOff?: string }>({});
  const inputsValid = !fieldErrors.income && !fieldErrors.oneOff;

  const monthWindow = useMemo(() => monthWindowFor(asOf), [asOf]);
  const coverage = useMemo(() => (monthWindow ? weeksForWindow(planning.weeks, monthWindow) : null), [planning.weeks, monthWindow]);
  const record = useMemo(() => (coverage ? summarizePlanVsRecord(coverage) : null), [coverage]);
  const comparison = useMemo(() => simulateScenario(draft, fixedCosts, monthlyIncome), [draft, fixedCosts, monthlyIncome]);
  const currentBaseline = useMemo(() => captureBaseline(scopeKey, fixedCosts, monthlyIncome), [scopeKey, fixedCosts, monthlyIncome]);
  const stale = !baselineMatches(currentBaseline, baseline);

  // 스코프가 바뀌면 이전 스코프의 초안/기준을 그대로 두지 않는다(사적 계획 자동 저장 없음).
  const [storedScope, setStoredScope] = useState(scopeKey);
  if (storedScope !== scopeKey) {
    setStoredScope(scopeKey);
    setDraft(EMPTY_DRAFT);
    setIncomeDraft("");
    setOneOffDraft("");
    setCostTarget(null);
    setCostAmount("");
    setFieldErrors({});
    setFeedback(null);
    setBaseline(captureBaseline(scopeKey, fixedCosts, monthlyIncome));
  }

  function setIncome(value: string) {
    setIncomeDraft(value);
    if (value.trim() === "") { setDraft(d => ({ ...d, newIncome: null })); setFieldErrors(e => ({ ...e, income: undefined })); setFeedback(null); return; }
    const parsed = parseKrwInput(value);
    if (!parsed.ok) { setFieldErrors(e => ({ ...e, income: parsed.message })); return; }
    setFieldErrors(e => ({ ...e, income: undefined }));
    setDraft(d => ({ ...d, newIncome: parsed.value }));
    setFeedback(null);
  }

  function setOneOff(value: string) {
    setOneOffDraft(value);
    if (value.trim() === "") { setDraft(d => ({ ...d, oneOff: 0 })); setFieldErrors(e => ({ ...e, oneOff: undefined })); setFeedback(null); return; }
    const parsed = parseKrwInput(value);
    if (!parsed.ok) { setFieldErrors(e => ({ ...e, oneOff: parsed.message })); return; }
    setFieldErrors(e => ({ ...e, oneOff: undefined }));
    setDraft(d => ({ ...d, oneOff: parsed.value }));
    setFeedback(null);
  }

  function addCostPatch() {
    if (!costTarget) { setFeedback({ text: "변경할 항목을 선택하세요.", tone: "error" }); return; }
    const parsed = parseKrwInput(costAmount);
    if (!parsed.ok) { setFeedback({ text: parsed.message, tone: "error" }); return; }
    setDraft(d => ({ ...d, costs: [...d.costs.filter(patch => patch.costId !== costTarget), { costId: costTarget, newAmount: parsed.value }] }));
    setCostAmount("");
    setCostTarget(null);
    setFeedback(null);
  }

  function applyDraft() {
    if (!canEdit) return;
    if (!inputsValid) { setFeedback({ text: "입력 오류를 먼저 해결하세요 — 오류가 남아 있는 동안은 적용할 수 없습니다.", tone: "error" }); return; }
    if (comparison.invalidCostIds.length > 0 && draft.costs.length === comparison.invalidCostIds.length && draft.newIncome === null) {
      setFeedback({ text: "가정 항목이 모두 목록에서 사라져 적용할 재발 변경이 없습니다. 다시 비교하세요.", tone: "error" });
      return;
    }
    if (!window.confirm(
      `현재 가계부에 재발 변경을 적용합니다(월수입 ${draft.newIncome !== null ? "변경" : "유지"} · 고정비 ${comparison.invalidCostIds.length < draft.costs.length ? draft.costs.length - comparison.invalidCostIds.length : 0}개 · 일회성 가정은 미포함). 적용 전 복구본이 저장되며 다른 탭에서 확인되지 않은 서버 반영은 일어나지 않습니다. 계속할까요?`
    )) return;
    if (!actions.saveRecoveryCopy()) {
      setFeedback({ text: "적용 전 복구본을 저장하지 못해 변경을 적용하지 않았습니다. 저장 공간을 확보하세요.", tone: "error" });
      return;
    }
    if (!baselineMatches(captureBaseline(scopeKey, fixedCosts, monthlyIncome), baseline)) {
      setFeedback({ text: "기준 데이터가 바뀌었습니다. 다시 비교(재생성) 후 적용하세요 — 오래된 초안은 적용하지 않았습니다.", tone: "error" });
      setBaseline(captureBaseline(scopeKey, fixedCosts, monthlyIncome));
      return;
    }
    const result = actions.applyPatches(applicablePatches(draft, fixedCosts));
    if (!result.ok) { setFeedback({ text: result.message, tone: "error" }); return; }
    setFeedback({ text: result.message, tone: "ok" });
    setDraft(EMPTY_DRAFT);
    setIncomeDraft("");
    setOneOffDraft("");
    setFieldErrors({});
    setBaseline(captureBaseline(scopeKey, fixedCosts, monthlyIncome));
  }

  if (!monthWindow || !coverage || !record) return null;
  const costName = (id: string) => fixedCosts.find(item => item.id === id)?.name ?? "삭제된 항목";

  return (
    <details className="quiet-disclosure month-review" open={false}>
      <summary>월말 점검 · 다음 달 가정</summary>
      <Text size="xs" c="dimmed">
        {monthWindow.label} 기간기록기준(한국 시간 {monthWindow.from} ~ {monthWindow.toInclusive}). 주가 달 경계를 걸치면 일할 안분하지 않고 아래에 주 그대로 표시합니다.
      </Text>

      <div className="month-review-record">
        <Text size="sm">주간 계획 합계(달 안 주만): <Text component="span" fw={700} className="tnum">{record.planned === null ? "기록 없음" : formatWon(record.planned)}</Text></Text>
        {record.hasRecords ? (
          <Text size="sm">기록된 사용액 합계: <Text component="span" fw={700} className="tnum">{record.recorded === null ? "기록 없음" : formatWon(record.recorded)}</Text></Text>
        ) : (
          <Text size="xs" c="dimmed">사용액 기록이 없어 계획 대비 실적 비교는 표시하지 않습니다(계획 vs 계획만).</Text>
        )}
        {record.difference !== null ? <Text size="xs" c="dimmed">기록 기준 차이 {formatWon(record.difference)} · 지출 전량 반영이 아닌 입력 기준</Text> : null}
        {coverage.straddling.length > 0 ? (
          <Text size="xs" c="dimmed">경계 주(월 합계 미포함): {coverage.straddling.map(week => {
            try {
              const end = planningWeekEnd(week.weekStart);
              return `${formatCivilDateShort(week.weekStart)}~${formatCivilDateShort(end)}${week.budgetAmount !== null ? ` · 계획 ${formatWon(week.budgetAmount)}` : ""}${week.spentAmount !== null ? ` · 기록 ${formatWon(week.spentAmount)}` : ""}`;
            } catch {
              return `${formatCivilDateShort(week.weekStart)} · 안분 표시`;
            }
          }).join(" / ")}</Text>
        ) : null}
      </div>

      <fieldset disabled={!canEdit} style={{ border: "none", padding: 0, margin: "8px 0 0" }}>
        <div className="month-review-whatif">
          <Text size="sm" fw={600}>다음 달 가정(원본 변경 전 임시 초안)</Text>
          <div className="reserve-row-edit-line">
            <TextInput size="xs" aria-label="가정 월수입" placeholder="월수입 가정(원)" inputMode="numeric" value={incomeDraft} onChange={event => setIncome(event.currentTarget.value)} />
            <TextInput size="xs" aria-label="일회성 지출 가정" placeholder="일회성 지출(이번 달 가정)" inputMode="numeric" value={oneOffDraft} onChange={event => setOneOff(event.currentTarget.value)} />
          </div>
          <div className="reserve-row-edit-line">
            <Select
              size="xs"
              aria-label="가정할 고정비 항목"
              placeholder="항목 선택"
              data={fixedCosts.map(item => ({ value: item.id, label: item.name }))}
              value={costTarget}
              onChange={value => setCostTarget(value)}
              searchable
            />
            <TextInput size="xs" aria-label="가정할 새 금액" placeholder="새 금액(원)" inputMode="numeric" value={costAmount} onChange={event => setCostAmount(event.currentTarget.value)} />
            <Button size="compact-xs" variant="subtle" onClick={addCostPatch} disabled={!costTarget}>가정에 추가</Button>
          </div>
          {draft.costs.length > 0 ? (
            <div className="month-review-patches">
              {draft.costs.map(patch => (
                <Text key={patch.costId} size="xs">
                  {costName(patch.costId)} → {formatWon(patch.newAmount)}{" "}
                  <Button size="compact-xs" variant="subtle" onClick={() => setDraft(d => ({ ...d, costs: d.costs.filter(item => item.costId !== patch.costId) }))}>지우기</Button>
                </Text>
              ))}
            </div>
          ) : null}
          <Text size="xs" c="dimmed">필수·보호 항목 절감은 자동으로 권하지 않습니다. 변경 여부와 관계는 사용자가 선택합니다.</Text>
        </div>
      </fieldset>

      <div className="month-review-compare" aria-label="기준과 가정 비교">
        <Text size="sm">월 고정비(환산) 기준 {formatWon(comparison.baselineExpense)} → 가정 {formatWon(comparison.scenarioExpense)} ({comparison.expenseDelta >= 0 ? "+" : "−"}{formatWon(Math.abs(comparison.expenseDelta))})</Text>
        {comparison.baselineBalance !== null && comparison.scenarioBalance !== null ? (
          <Text size="sm">계획 잔여(수입−고정비) 기준 {formatWon(comparison.baselineBalance)} → 가정 {formatWon(comparison.scenarioBalance)}</Text>
        ) : (
          <Text size="xs" c="dimmed">월수입이 기록되지 않아 잔여 비교는 계획 대비 계획으로만 표시됩니다.</Text>
        )}
        {comparison.oneOff > 0 ? <Text size="xs" c="dimmed">일회성 가정 {formatWon(comparison.oneOff)} — 재발 합계와 별도이며 적용 시 원본 기록에 저장되지 않습니다.</Text> : null}
        <Text size="xs" c="dimmed">예측이 아니라 사용자가 입력한 가정의 대조입니다(AI·자동 예측 없음).</Text>
      </div>

      {!inputsValid ? (
        <Text size="xs" c="rose" role="alert">{fieldErrors.income ?? fieldErrors.oneOff} — 비교 숫자는 마지막 유효 값 기준이며, 오류가 있는 동안은 적용할 수 없습니다.</Text>
      ) : null}
      {stale && comparison.hasChanges ? (
        <div role="alert">
          <Text size="xs" c="rose">비교 기준(현행 정본)이 바뀌었습니다. 아래 '이 변경 적용'은 비활성 — 재생성 후 다시 확인하세요.</Text>
          <Button size="compact-xs" variant="default" onClick={() => { setBaseline(currentBaseline); setFeedback(null); }}>다시 비교</Button>
        </div>
      ) : null}
      {canEdit && comparison.hasChanges ? (
        <Button
          size="xs"
          variant="default"
          color="teal"
          mt="xs"
          disabled={stale || !inputsValid}
          onClick={applyDraft}
        >
          이 변경 적용(재발 항목만)
        </Button>
      ) : null}
      {isViewer ? <Text size="xs" c="dimmed" role="status">보기 전용입니다. 가정 비교만 사용할 수 있습니다.</Text> : null}
      {feedback ? <Text size="xs" role="status" c={feedback.tone === "error" ? "rose" : "dimmed"}>{feedback.text}</Text> : null}
    </details>
  );
}
