import { useMemo, useState } from "react";
import { Button, Select, Text, TextInput } from "@mantine/core";
import type { WorkspacePlanningData } from "@living-cost-manager/shared";
import type { FixedCost } from "../lib/budget";
import { formatWon } from "../lib/formatting";
import { kstCivilDateString } from "../lib/planningTime";
import { parseKrwInput, type ReserveDraft } from "../lib/planningStorage";
import { annualCandidates, buildReserveViews, type ReserveView } from "../lib/reserveMath";

interface ReservePanelProps {
  planning: WorkspacePlanningData;
  fixedCosts: readonly FixedCost[];
  asOf: Date;
  canEdit: boolean;
  actions: {
    editReserve: (draft: ReserveDraft) => { ok: boolean; message: string };
    deleteReserve: (id: string) => { ok: boolean; message: string };
    linkReserve: (id: string, costId: string, costLabel?: string) => { ok: boolean; message: string };
  };
}

function ReserveRow({ view, fixedCosts, canEdit, actions, onFeedback }: {
  view: ReserveView;
  fixedCosts: readonly FixedCost[];
  canEdit: boolean;
  actions: ReservePanelProps["actions"];
  onFeedback: (message: string, ok: boolean) => void;
}) {
  const [savedDraft, setSavedDraft] = useState("");
  const [targetDraft, setTargetDraft] = useState("");
  const [dueDraft, setDueDraft] = useState("");
  const [linkTarget, setLinkTarget] = useState<string | null>(null);

  function saveRecorded() {
    const parsed = parseKrwInput(savedDraft);
    if (!parsed.ok) { onFeedback(parsed.message, false); return; }
    const result = actions.editReserve({
      id: view.id,
      costId: view.costId,
      savedAmount: parsed.value,
      targetAmount: view.targetSource === "recorded" ? view.effectiveTarget : null,
      targetDueDate: view.dueDate,
      recordedAt: new Date().toISOString(),
      ...(view.isOrphan && view.label ? { costLabel: view.label.slice(0, 120) } : {})
    });
    if (!result.ok) { onFeedback(result.message, false); return; }
    onFeedback("직접 기록한 준비 금액을 저장했습니다(입력 기준).", true);
    setSavedDraft("");
  }

  function saveGoal() {
    const hasTarget = targetDraft.trim() !== "";
    const hasDue = dueDraft.trim() !== "";
    if (!hasTarget && !hasDue) { onFeedback("목표액 또는 목표 납부일 중 하나 이상을 입력하세요.", false); return; }
    let target: number | null = view.targetSource === "recorded" ? view.effectiveTarget : null;
    if (hasTarget) {
      const parsed = parseKrwInput(targetDraft);
      if (!parsed.ok) { onFeedback(parsed.message, false); return; }
      target = parsed.value;
    }
    if (hasDue && !/^\d{4}-\d{2}-\d{2}$/.test(dueDraft)) { onFeedback("목표 납부일을 YYYY-MM-DD 형식으로 입력하세요.", false); return; }
    const result = actions.editReserve({
      id: view.id,
      costId: view.costId,
      savedAmount: view.saved,
      targetAmount: target,
      targetDueDate: hasDue ? dueDraft : view.dueDate,
      recordedAt: new Date().toISOString(),
      ...(view.isOrphan && view.label ? { costLabel: view.label.slice(0, 120) } : {})
    });
    if (!result.ok) { onFeedback(result.message, false); return; }
    onFeedback("목표 기록을 저장했습니다.", true);
    setTargetDraft("");
    setDueDraft("");
  }

  return (
    <li className="reserve-panel-row">
      <div className="reserve-row-head">
        <Text size="sm" fw={600} truncate>{view.label}</Text>
        <Text size="xs" className="tnum">{view.effectiveTarget === null ? "목표 미정" : `목표 ${formatWon(view.effectiveTarget)}${view.targetSource === "item" ? " · 항목 금액 기준(기록된 목표 아님)" : ""}`}</Text>
        <Text size="xs" className="tnum">{view.saved === null ? "기록 없음" : `모아둠 ${formatWon(view.saved)}`}</Text>
      </div>
      {view.percent !== null ? (
        <div className="reserve-progress" role="progressbar" aria-valuenow={view.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${view.label} 준비 진행률`}>
          <div className="reserve-progress-bar" style={{ width: `${view.percent}%` }} />
        </div>
      ) : null}
      <div className="reserve-row-facts">
        {view.remaining !== null ? <Text size="xs" className="tnum">남은 목표 {formatWon(view.remaining)}</Text> : null}
        {view.perContribution !== null && view.contributionsLeft !== null ? (
          <Text size="xs" className="tnum">마감까지 납부 {view.contributionsLeft}회 · 회당 약 {formatWon(view.perContribution)}(직접 기록 기준)</Text>
        ) : null}
        {view.dueDate ? <Text size="xs" c="dimmed">목표 납부일 {view.dueDate}</Text> : <Text size="xs" c="dimmed">목표 납부일 미입력</Text>}
      </div>
      {view.notice ? <Text size="xs" c="dimmed">{view.notice}</Text> : null}
      {view.overFunded !== null && view.overFunded > 0 ? <Text size="xs">목표 초과 기록 {formatWon(view.overFunded)}</Text> : null}
      {canEdit ? (
        <div className="reserve-row-edit">
          <div className="reserve-row-edit-line">
            <TextInput size="xs" aria-label={`${view.label} 모아둔 금액`} placeholder="모아둔 금액(원)" inputMode="numeric" value={savedDraft} onChange={event => setSavedDraft(event.currentTarget.value)} />
            <Button size="compact-xs" variant="default" onClick={saveRecorded}>기록</Button>
          </div>
          <div className="reserve-row-edit-line">
            <TextInput size="xs" aria-label={`${view.label} 목표 금액`} placeholder="목표액(선택)" inputMode="numeric" value={targetDraft} onChange={event => setTargetDraft(event.currentTarget.value)} />
            <TextInput size="xs" aria-label={`${view.label} 목표 납부일`} placeholder="YYYY-MM-DD" value={dueDraft} onChange={event => setDueDraft(event.currentTarget.value)} />
            <Button size="compact-xs" variant="subtle" onClick={saveGoal}>목표 저장</Button>
          </div>
          {view.isOrphan ? (
            <div className="reserve-row-edit-line">
              <Select
                size="xs"
                aria-label={`${view.label} 재연결 항목`}
                placeholder="다른 항목과 연결"
                data={fixedCosts.map(item => ({ value: item.id, label: item.name }))}
                value={linkTarget}
                onChange={value => setLinkTarget(value)}
                searchable
                disabled={fixedCosts.length === 0}
              />
              <Button
                size="compact-xs"
                variant="subtle"
                disabled={linkTarget === null || linkTarget === view.costId}
                onClick={() => {
                  const cost = fixedCosts.find(item => item.id === linkTarget);
                  if (!cost) return;
                  const result = actions.linkReserve(view.id, cost.id);
                  onFeedback(result.ok ? "준비금을 선택한 항목에 다시 연결했습니다. 과거 기록은 그대로입니다." : result.message, result.ok);
                  setLinkTarget(null);
                }}
              >
                연결
              </Button>
            </div>
          ) : null}
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => {
              if (window.confirm("이 준비금 기록을 삭제할까요? 삭제해도 실제 지출 기록은 바뀌지 않습니다.")) {
                const result = actions.deleteReserve(view.id);
                onFeedback(result.ok ? "준비금 기록을 삭제했습니다." : result.message, result.ok);
              }
            }}
          >
            기록 삭제
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** 큰지출준비(싱킹 펀드) — 기존 고정비 표에 컬럼을 추가하지 않는 별도 압축 패널. */
export function ReservePanel({ planning, fixedCosts, asOf, canEdit, actions }: ReservePanelProps) {
  const today = useMemo(() => kstCivilDateString(asOf) ?? "", [asOf]);
  const views = useMemo(() => (today ? buildReserveViews(planning, fixedCosts, today) : []), [planning, fixedCosts, today]);
  const candidates = useMemo(() => annualCandidates(planning, fixedCosts), [planning, fixedCosts]);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [addTarget, setAddTarget] = useState<string | null>(null);

  if (views.length === 0 && candidates.length === 0) return <section className="reserve-panel" aria-label="큰지출준비"><Text fw={600} size="sm">큰 지출 준비</Text><Text size="sm" c="dimmed" mt="sm">아직 준비할 연간 납부 항목이 없습니다. 항목에서 여러 달마다 납부하는 고정비를 추가하면 준비금을 기록할 수 있어요.</Text><Text size="xs" c="dimmed" mt="sm">준비금은 직접 기록한 금액이며, 실제 계좌 잔액이 아닙니다.</Text></section>;

  return (
    <section className="reserve-panel" aria-label="큰지출준비">
      <Text fw={600} size="sm">큰지출준비</Text>
      <Text size="xs" c="dimmed">
        '모아둔 돈'은 사용자가 직접 기록한 기준이며 은행 확인 잔액이 아닙니다. 준비금은 고정비 월 환산이나 주간 사용액 합계와 이중 계산되지 않습니다.
      </Text>
      {views.length > 0 ? (
        <ul className="reserve-panel-list" style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
          {views.map(view => (
            <ReserveRow key={view.id} view={view} fixedCosts={fixedCosts} canEdit={canEdit} actions={actions} onFeedback={(text, ok) => setFeedback({ text, ok })} />
          ))}
        </ul>
      ) : (
        <Text size="xs" c="dimmed" py="xs">아직 준비금 기록이 없습니다. 아래 연간 항목에서 추가하세요.</Text>
      )}
      {canEdit && candidates.length > 0 ? (
        <div className="reserve-row-edit-line" style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
          <Select
            size="xs"
            aria-label="준비금으로 추가할 연간 항목"
            placeholder="연간 항목 선택"
            data={candidates.map(item => ({ value: item.id, label: `${item.name} · ${formatWon(item.amount)}` }))}
            value={addTarget}
            onChange={value => setAddTarget(value)}
            searchable
          />
          <Button
            size="compact-xs"
            variant="default"
            disabled={addTarget === null}
            onClick={() => {
              const cost = candidates.find(item => item.id === addTarget);
              if (!cost) return;
              const result = actions.editReserve({ costId: cost.id, savedAmount: null, targetAmount: null, targetDueDate: null, recordedAt: null });
              setFeedback({ text: result.ok ? "준비금 자리에 기록을 시작했습니다. 목표·금액은 직접 채우세요." : result.message, ok: result.ok });
              setAddTarget(null);
            }}
          >
            준비금 추가
          </Button>
        </div>
      ) : null}
      {feedback ? <Text size="xs" role="status" c={feedback.ok ? "dimmed" : "rose"}>{feedback.text}</Text> : null}
    </section>
  );
}
