// 큰지출준비(싱킹 펀드) 파생 — 준비금은 "직접 기록 기준"일 뿐 은행 확인 잔액이
// 아니고, 고정비 월 환산이나 주간 사용액 합계와 이중 계산하지 않는다.
// 회당 필요액은 "오늘 이후 확인된 납부 주기 발생 수"라는 명시 캘린더 근거로만
// 계산하고, 납부일 미확인/과거면 0으로 나누거나 0원을 권하지 않는다.
import type { FixedCost } from "./budget";
import type { WorkspacePlanningData } from "@living-cost-manager/shared";
import { addCivilDays, parseCivilDate } from "./planningTime";
import { enumerateDueOccurrences } from "./paydayTimeline";

export const MAX_KRW_LIMIT = 2147483647;

export type ReserveView = {
  id: string;
  costId: string;
  label: string;
  isOrphan: boolean;
  saved: number | null;
  /** 유효 목표액: 기록된 목표 없으면 현재 항목 금액(서버 기록 아님 표시). */
  effectiveTarget: number | null;
  targetSource: "recorded" | "item" | null;
  remaining: number | null;
  dueDate: string | null;
  dueIsPast: boolean;
  /** 오늘 이후 마감까지의 확인된 납부 발생 수. 세지 못하면 null. */
  contributionsLeft: number | null;
  perContribution: number | null;
  /** 0~100 clamp 진행률(bar). saved 미기록이면 null. */
  percent: number | null;
  overFunded: number | null;
  notice: string | null;
};

function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}

export function buildReserveViews(
  planning: WorkspacePlanningData,
  fixedCosts: readonly FixedCost[],
  today: string
): ReserveView[] {
  if (!parseCivilDate(today)) return [];
  return planning.reserves.map(reserve => {
    const cost = fixedCosts.find(item => item.id === reserve.costId) ?? null;
    const isOrphan = cost === null;
    const label = cost?.name ?? reserve.costLabel ?? "연결된 항목 없음(기록 보관)";
    const effectiveTarget = reserve.targetAmount ?? (cost ? cost.amount : null);
    const targetSource = reserve.targetAmount !== null ? "recorded" as const : (cost ? "item" as const : null);
    const remaining = effectiveTarget !== null && reserve.savedAmount !== null
      ? Math.max(effectiveTarget - reserve.savedAmount, 0)
      : null;
    const dueDate = reserve.targetDueDate;
    const dueIsPast = dueDate !== null && dueDate < today;
    let contributionsLeft: number | null = null;
    let perContribution: number | null = null;
    let notice: string | null = null;
    if (!isOrphan && cost && dueDate !== null && !dueIsPast) {
      const occurrences = enumerateDueOccurrences([cost], addCivilDays(today, 1) ?? today, addCivilDays(dueDate, 1) ?? dueDate);
      const own = occurrences.occurrences.filter(entry => entry.item.id === cost.id);
      contributionsLeft = own.length > 0 ? own.length : null;
      if (contributionsLeft === null) {
        notice = "마감 전 확인된 납부 주기가 없어 회당 필요액은 표시하지 않습니다.";
      }
    } else if (dueDate === null) {
      notice = "납부일(목표일)이 확인되지 않았습니다. 회당 필요액 권유 없이 남은 금액만 표시합니다.";
    } else if (dueIsPast) {
      notice = "목표 납부일이 지났습니다. 남은 금액을 확인하고 이번 납부 대비를 직접 정하세요.";
    }
    if (remaining !== null && contributionsLeft !== null && contributionsLeft > 0) {
      perContribution = ceilDiv(remaining, contributionsLeft);
    }
    let percent: number | null = null;
    let overFunded: number | null = null;
    if (reserve.savedAmount !== null) {
      if (effectiveTarget !== null && effectiveTarget > 0) percent = Math.min(100, Math.round((reserve.savedAmount / effectiveTarget) * 100));
      else if (effectiveTarget === 0) percent = reserve.savedAmount > 0 ? 100 : 0;
      if (effectiveTarget !== null && reserve.savedAmount > effectiveTarget) {
        overFunded = Math.min(reserve.savedAmount - effectiveTarget, MAX_KRW_LIMIT);
      }
    }
    if (overFunded !== null && overFunded > 0 && notice === null) {
      notice = "기록된 금액이 목표를 넘었습니다(초과분은 이 항목 목표에서 자동 이월되지 않습니다).";
    }
    return {
      id: reserve.id,
      costId: reserve.costId,
      label,
      isOrphan,
      saved: reserve.savedAmount,
      effectiveTarget,
      targetSource,
      remaining,
      dueDate,
      dueIsPast,
      contributionsLeft,
      perContribution,
      percent,
      overFunded,
      notice
    };
  });
}

/** 준비금 추가 대상: 연 이상 주기(periodMonths>=12)의 확인 항목 중 준비금이 없는 것. */
export function annualCandidates(planning: WorkspacePlanningData, fixedCosts: readonly FixedCost[]): FixedCost[] {
  const taken = new Set(planning.reserves.map(reserve => reserve.costId));
  return fixedCosts.filter(item => item.periodMonths >= 12 && !taken.has(item.id));
}
