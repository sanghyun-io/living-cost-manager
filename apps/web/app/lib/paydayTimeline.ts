// 급여 주기 타임라인 파생(보고서 제안 3): 기존 납부 예정 정본(UpcomingDues)의
// 그룹핑 렌즈일 뿐, 네 번째 패널이나 새 목록이 아니다. KST 민법 날짜는 Intl parts
// 로 얻은 문자열을 호스트 로컬 정오 Date 로 변환해 computeNextDueDate 의 캘린더
// 산술을Drive하고, 결과는 다시 민법 문자열로 정규화 — UTC/Pacific/KST 등 호스트
// 타임존에서 결과가 동일하다. getUpcomingDues 는 항목당 1회만 반환하므로 단기
// 주기에서 창 안 2회 발생을 놓치지 않도록 모든 발생을 열거한다.
import { computeNextDueDate, type PredictableFixedCost } from "@living-cost-manager/shared";
import { addCivilDays, paydayOccurrences, parseCivilDate } from "./planningTime";

export type PaydayOccurrence<T> = { item: T; date: string; daysUntil: number };

export type PaydayGroup<T> = {
  /** empty+확인 발생 0 = 0(정직한 비어 있음); 합이 원 단위 영역(MAX_INT)을
   * 넘으면 total=null + overflow=true — 절대 0으로 위장하지 않는다. 개별 기록은
   * 각각 유효해도 합만 영역 밖일 수 있다. */
  total: number | null;
  overflow: boolean;
  occurrenceCount: number;
  items: PaydayOccurrence<T>[];
};

export type PaydayTimeline<T> = {
  window: { from: string; untilExclusive: string };
  /** 창 안에서 가장 가까운 다음 급여일(월말 clamp 반영) 또는 창 밖이면 null. */
  paydayDate: string | null;
  /** 급여일이 창 안에 없을 때 그룹 라벨 기준: 오늘~창 끝 전체가 '다음 급여일 전'. */
  before: PaydayGroup<T>;
  after: PaydayGroup<T>;
  unknownCount: number;
};

function toLocalNoon(date: string): Date | null {
  const parsed = parseCivilDate(date);
  if (!parsed) return null;
  return new Date(parsed.year, parsed.month - 1, parsed.day, 12);
}

function toCivil(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** [from, untilExclusive) 내 항목의 모든 실제 청구 발생(오름차순). 일정 미확인은
 * unknownCount 로 별도 계상하고 절대 발생으로 위장하지 않는다. */
export function enumerateDueOccurrences<T extends PredictableFixedCost>(
  items: readonly T[],
  from: string,
  untilExclusive: string
): { occurrences: PaydayOccurrence<T>[]; unknownCount: number } {
  const base = toLocalNoon(from);
  const occurrences: PaydayOccurrence<T>[] = [];
  let unknownCount = 0;
  if (!base) return { occurrences, unknownCount };
  const fromMs = Date.UTC(...(from.split("-").map(Number) as [number, number, number]));
  for (const item of items) {
    if (item.amount <= 0) continue;
    let due = computeNextDueDate(item, base);
    if (!due) { unknownCount += 1; continue; }
    let guard = 0;
    let cursor = base;
    while (due && guard < 130) {
      const civil = toCivil(due);
      if (civil >= untilExclusive) break;
      occurrences.push({ item, date: civil, daysUntil: Math.round((Date.UTC(...(civil.split("-").map(Number) as [number, number, number])) - fromMs) / 86_400_000) });
      const nextDay = toLocalNoon(addCivilDays(civil, 1) ?? "");
      if (!nextDay) break;
      cursor = nextDay;
      due = computeNextDueDate(item, cursor);
      guard += 1;
    }
  }
  occurrences.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.item.id < b.item.id ? -1 : 1));
  return { occurrences, unknownCount };
}

const MAX_GROUP_TOTAL = 2147483647;

/** empty+일정 미확인 없음 = 정직한 0. 미확인이 남아 있으면 total=null(0 위장 금지).
 * 합이 원 단위 영역 초과면 total=null + overflow=true — 개별 기록은 유효해도 합은 계산 불가. */
function groupOf<T extends PredictableFixedCost>(items: PaydayOccurrence<T>[], hasUnknown: boolean): PaydayGroup<T> {
  const sum = items.reduce((total, entry) => total + entry.item.amount, 0);
  const withinDomain = Number.isSafeInteger(sum) && sum <= MAX_GROUP_TOTAL;
  if (items.length === 0) return { total: hasUnknown ? null : 0, overflow: false, occurrenceCount: 0, items };
  return {
    total: withinDomain ? sum : null,
    overflow: !withinDomain,
    occurrenceCount: items.length,
    items
  };
}

/** 급여일(1..31) 기준으로 확인된 발생을 이전/이후로 나눈다. 급여일이 창 안에
 * 없으면 전부 '다음 급여일 전' 그룹이고 paydayDate 는 창 안 다음 발생이 없으면
 * 그룹 경계 표시용으로만 쓴다(미설정이면 호출 측이 이 파생을 쓰지 않는다). */
export function buildPaydayTimeline<T extends PredictableFixedCost>(
  items: readonly T[],
  from: string,
  untilExclusive: string,
  paydayDay: number
): PaydayTimeline<T> {
  const { occurrences, unknownCount } = enumerateDueOccurrences(items, from, untilExclusive);
  const horizon = addCivilDays(untilExclusive, 45) ?? untilExclusive;
  const nextPayday = paydayOccurrences(from, horizon, paydayDay)[0] ?? null;
  const inWindow = nextPayday && nextPayday < untilExclusive ? nextPayday : null;
  const beforeItems = occurrences.filter(entry => !inWindow || entry.date <= inWindow);
  const afterItems = occurrences.filter(entry => inWindow !== null && entry.date > inWindow);
  return {
    window: { from, untilExclusive },
    paydayDate: nextPayday,
    before: groupOf(beforeItems, unknownCount > 0),
    after: groupOf(afterItems, unknownCount > 0),
    unknownCount
  };
}
