import { useMemo, useState } from "react";
import { Button, Select, Text, TextInput } from "@mantine/core";
import { planningWeekEnd, type WorkspacePlanningData } from "@living-cost-manager/shared";
import { formatWon } from "../lib/formatting";
import {
  addCivilDays,
  formatCivilDateShort,
  kstCivilDateString,
  paydayOccurrences,
  weekStartFor
} from "../lib/planningTime";
import { parseKrwInput } from "../lib/planningStorage";

export interface WeeklyBudgetActions {
  setBudget: (weekStart: string, amount: number | null) => { ok: boolean; message: string };
  addSpent: (weekStart: string, increment: number) => { ok: boolean; message: string };
  setSpent: (weekStart: string, total: number) => { ok: boolean; message: string };
  setPayday: (day: number | null) => { ok: boolean; message: string };
}

interface WeeklyBudgetPanelProps {
  compact?: boolean;
  data: WorkspacePlanningData;
  /** 기준 시각(page 의 referenceInstant). 이 값으로 "이번 주"와 KST 오늘을 해석한다. */
  asOf: Date;
  canEdit: boolean;
  isViewer: boolean;
  hasServer: boolean;
  serverSupport: "unknown" | "available" | "missing" | "forbidden" | "unavailable";
  serverConfirmed: boolean;
  serverDirty: boolean;
  conflict: boolean;
  saveError: string;
  actions: WeeklyBudgetActions;
}

function formatRecordedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** 주간 예산 + 최소 사용액 확인(보고서 제안 2). 사용 기록이 없으면 0원이 아니라
 * "사용액 기록 없음"을, 예산 미입력 시 "예산미설정"을 표시한다. */
export function WeeklyBudgetPanel({
  data, asOf, canEdit, isViewer, hasServer, serverSupport, serverConfirmed, serverDirty, conflict, saveError, actions, compact = false
}: WeeklyBudgetPanelProps) {
  const [offset, setOffset] = useState(0);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [addDraft, setAddDraft] = useState("");
  const [totalDraft, setTotalDraft] = useState("");
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const kstToday = useMemo(() => kstCivilDateString(asOf) ?? "", [asOf]);
  const currentWeek = useMemo(() => (kstToday ? weekStartFor(kstToday, data.weekStartDay) : null), [kstToday, data.weekStartDay]);
  const weekStart = useMemo(() => {
    if (!currentWeek) return null;
    let candidate = currentWeek;
    if (offset !== 0) {
      const shifted = addCivilDays(currentWeek, offset * 7);
      if (shifted && shifted <= "9999-12-25" && shifted >= "0001-01-01") candidate = shifted;
    }
    return candidate;
  }, [currentWeek, offset]);

  const nextPayday = useMemo(() => {
    if (data.paydayDay === null || !kstToday) return null;
    const horizon = addCivilDays(kstToday, 60);
    if (!horizon) return null;
    const occurrences = paydayOccurrences(kstToday, horizon, data.paydayDay);
    return occurrences[0] ?? null;
  }, [data.paydayDay, kstToday]);

  const history = useMemo(() => [...data.weeks].sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1)), [data.weeks]);

  if (!weekStart) return null;
  const selectedWeek: string = weekStart;

  const weekEnd = planningWeekEnd(selectedWeek);
  const record = data.weeks.find(item => item.weekStart === selectedWeek) ?? null;
  const budget = record?.budgetAmount ?? null;
  const spent = record?.spentAmount ?? null;
  const remaining = budget !== null && spent !== null ? budget - spent : null;

  function report(result: { ok: boolean; message: string }, successText: string) {
    if (!result.ok) setFeedback({ tone: "error", text: result.message });
    else setFeedback({ tone: "ok", text: successText });
  }

  function submitBudget(mode: "set" | "clear") {
    if (mode === "clear") {
      report(actions.setBudget(selectedWeek, null), "이 주의 예산을 미설정으로 두었습니다(0원이 아닙니다).");
      setBudgetDraft("");
      return;
    }
    const parsed = parseKrwInput(budgetDraft);
    if (!parsed.ok) { setFeedback({ tone: "error", text: parsed.message }); return; }
    report(actions.setBudget(selectedWeek, parsed.value), "주간 예산을 기록했습니다.");
    setBudgetDraft("");
  }

  function submitAdd() {
    const parsed = parseKrwInput(addDraft);
    if (!parsed.ok) { setFeedback({ tone: "error", text: parsed.message }); return; }
    report(actions.addSpent(selectedWeek, parsed.value), "사용액을 기록에 더했습니다(입력 기준 합계).");
    setAddDraft("");
  }

  function submitTotal() {
    const parsed = parseKrwInput(totalDraft);
    if (!parsed.ok) {
      setFeedback({ tone: "error", text: totalDraft.trim() === "" ? "총액을 입력하세요. 비워 두면 0원이 아닙니다." : parsed.message });
      return;
    }
    report(actions.setSpent(selectedWeek, parsed.value), "이번 주 사용액 총액을 기록했습니다.");
    setTotalDraft("");
  }

  function submitPayday(value: string) {
    const day = value === "none" ? null : Number(value);
    if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) {
      setFeedback({ tone: "error", text: "급여일은 1~31일 사이여야 합니다." });
      return;
    }
    report(actions.setPayday(day), day === null ? "급여일 계획을 지웠습니다(말일·29·30·31일은 해당 월에 맞춰 적용)." : "급여일 계획을 기록했습니다.");
  }

  const storageNote = saveError
    ? saveError
    : !hasServer
      ? "이 기기에 저장됩니다. 로그인하면 서버와 동기화할 수 있습니다."
      : serverSupport === "missing"
        ? "이 서버에서는 계획 저장 기능을 제공하지 않습니다. 기기 저장 기록은 그대로 유지됩니다."
        : conflict
          ? "서버 기록과 충돌 — 확인 필요. 기기 기록은 유지됩니다."
          : !serverConfirmed
            ? "서버 기록 확인 전 · 기기 저장 사용 중"
            : serverDirty
              ? "기기에 저장됨 · 서버 미반영(데이터 관리에서 저장)"
              : "기기·서버 기록 일치(마지막 확인 기준)";

  return (
    <section className="weekly-budget-panel quiet-card" aria-label="주간 생활비">
      <div className="weekly-budget-header">
        <Text fw={600} size="sm">주간 생활비</Text>
        <Text size="xs" c="dimmed">{selectedWeek.slice(5).replace("-", "/")} ~ {weekEnd.slice(5).replace("-", "/")}{offset === 0 ? " · 이번 주" : ""}</Text>
      </div>
      <div className="weekly-budget-nav" role="group" aria-label="주 선택">
        <Button size="compact-xs" variant="subtle" onClick={() => setOffset(value => value - 1)} aria-label="이전 주">이전</Button>
        <Button size="compact-xs" variant={offset === 0 ? "light" : "subtle"} onClick={() => setOffset(0)} aria-label="이번 주로">이번 주</Button>
        <Button size="compact-xs" variant="subtle" onClick={() => setOffset(value => value + 1)} aria-label="다음 주">다음</Button>
      </div>

      <div className="weekly-budget-readout">
        <div>
          <Text size="xs" c="dimmed">주간 예산</Text>
          <Text fw={700} className="tnum">{budget === null ? "예산미설정" : formatWon(budget)}</Text>
        </div>
        <div>
          <Text size="xs" c="dimmed">기록된 사용액</Text>
          <Text fw={700} className="tnum">
            {spent === null ? "사용액 기록 없음" : formatWon(spent)}
            {spent !== null && record?.recordedAt ? <Text component="span" size="xs" c="dimmed"> · {formatRecordedAt(record.recordedAt)} 기록</Text> : null}
          </Text>
        </div>
        <div>
          <Text size="xs" c="dimmed">기록 기준 잔여</Text>
          <Text fw={700} className="tnum" c={remaining !== null && remaining < 0 ? "rose" : undefined}>
            {remaining === null ? "—" : formatWon(remaining)}
          </Text>
        </div>
      </div>
      {remaining !== null && remaining < 0 ? <Text size="xs" c="rose">기록 기준 예산을 넘었습니다. 실제 전 지출을 다 반영한 수치는 아닙니다.</Text> : null}
      {budget !== null && budget > 0 && spent !== null ? <progress className="weekly-budget-progress" aria-label="기록된 예산 사용률" max={budget} value={Math.min(spent, budget)} /> : null}

      <details className="weekly-entry" open={compact ? undefined : true}>
      <summary>{canEdit ? '지출 기록 / 예산 설정' : '급여일 확인'}</summary>
      {canEdit ? (
        <div className="weekly-budget-edit">
          <div className="weekly-budget-row">
            <TextInput
              size="xs"
              aria-label="주간 예산 금액"
              placeholder="예산(원)"
              inputMode="numeric"
              value={budgetDraft}
              onChange={event => setBudgetDraft(event.currentTarget.value)}
            />
            <Button size="compact-xs" variant="default" onClick={() => submitBudget("set")}>예산 설정</Button>
            <Button size="compact-xs" variant="subtle" onClick={() => submitBudget("clear")}>미설정</Button>
          </div>
          <div className="weekly-budget-row">
            <TextInput
              size="xs"
              aria-label="지출 추가 금액"
              placeholder="지출(원)"
              inputMode="numeric"
              value={addDraft}
              onChange={event => setAddDraft(event.currentTarget.value)}
            />
            <Button size="compact-xs" variant="default" onClick={submitAdd}>지출 추가</Button>
          </div>
          <div className="weekly-budget-row">
            <TextInput
              size="xs"
              aria-label="사용액 총액 수정"
              placeholder="총액(원)"
              inputMode="numeric"
              value={totalDraft}
              onChange={event => setTotalDraft(event.currentTarget.value)}
            />
            <Button size="compact-xs" variant="subtle" onClick={submitTotal}>사용액 수정</Button>
          </div>
          <Text size="xs" c="dimmed">사용액은 직접 입력한 합계 기준으로 더하거나 고칩니다. 개별 지출을 전량 추적하지는 않습니다.</Text>
        </div>
      ) : isViewer ? (
        <Text size="xs" c="dimmed" role="status">보기 전용 가계부입니다. 계획은 읽기만 가능합니다.</Text>
      ) : null}

      <div className="weekly-budget-payday">
        <Text size="xs" c="dimmed">급여일(선택)</Text>
        {canEdit ? (
          <Select
            size="xs"
            aria-label="급여일 선택"
            data={["미설정", ...Array.from({ length: 31 }, (_, index) => `${index + 1}일`)]}
            value={data.paydayDay === null ? "미설정" : `${data.paydayDay}일`}
            onChange={value => submitPayday(value === "미설정" ? "none" : String(Number((value ?? "1").replace("일", ""))))}
            allowDeselect={false}
            checkIconPosition="right"
          />
        ) : (
          <Text size="sm">{data.paydayDay === null ? "미설정" : `매월 ${data.paydayDay}일(해당 월 말일까지 조정)`}</Text>
        )}
        {data.paydayDay !== null && nextPayday ? (
          <Text size="xs" c="dimmed">다음 급여일 {formatCivilDateShort(nextPayday)}{nextPayday <= (addCivilDays(kstToday, 1) ?? "") ? " (임박)" : ""}</Text>
        ) : null}
        {data.paydayDay !== null && !nextPayday && kstToday > "9999-01-01" ? (
          <Text size="xs" c="dimmed">표시 범위를 넘는 급여일입니다.</Text>
        ) : null}
      </div>
      </details>
      {feedback ? <Text size="xs" role="status" c={feedback.tone === "error" ? "rose" : "dimmed"}>{feedback.text}</Text> : null}

      <details className="weekly-budget-history">
        <summary>기록 내역 · {history.length}주</summary>
        {history.length === 0 ? (
          <Text size="xs" c="dimmed" py="xs">아직 기록된 주가 없습니다. 이번 주 예산을 설정하면 첫 기록이 생깁니다.</Text>
        ) : (
          <ul className="weekly-budget-history-list">
            {history.slice(0, 12).map(week => (
              <li key={week.weekStart}>
                <Text size="xs">{week.weekStart.slice(5).replace("-", "/")} ~ {planningWeekEnd(week.weekStart).slice(5).replace("-", "/")}</Text>
                <Text size="xs" className="tnum">{week.budgetAmount === null ? "예산미설정" : formatWon(week.budgetAmount)}</Text>
                <Text size="xs" className="tnum" c="dimmed">{week.spentAmount === null ? "기록없음" : formatWon(week.spentAmount)}</Text>
              </li>
            ))}
            {history.length > 12 ? <li><Text size="xs" c="dimmed">최근 12주만 표시(전체 {history.length}주는 보관 중, 자동 삭제 없음)</Text></li> : null}
          </ul>
        )}
      </details>

      <Text size="xs" c="dimmed" className="weekly-budget-basis">
        입력 기준: 직접 입력한 주간 예산과 사용액 기록입니다. 계좌 잔액이나 자동 수집이 아니며, 남은 금액이 '안전하게 써도 되는 금액'을 보장하지 않습니다.
      </Text>
      {hasServer ? (
        <Text size="xs" c="dimmed">
          이 기록은 가계부 공유 멤버에게 표시되는 공통 계획입니다. 개인 설정(코칭 선호·마케팅 동의)은 포함되지 않습니다. 최대 520주 보관 · 오래된 기록은 자동 삭제되지 않습니다.
        </Text>
      ) : null}
      <Text size="xs" c="dimmed" className="weekly-budget-storage" role="status">{storageNote}</Text>
    </section>
  );
}
