// 주간 생활비 계획의 달력 계산 정본. 모든 "오늘"은 한국 시간(KST) 역법(cal) 날짜로
// Intl parts에서 해석하고(호스트 타임존 무관), 날짜 문자열 증분은 UTC 캘린더
// 산술로 수행해 DST/타임존 이동이 없다. 순수 함수 — React·storage 의존 없음.

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type CivilDate = { year: number; month: number; day: number };

/** Any instant → 그 순간의 KST "YYYY-MM-DD". formatToParts 라벨로 조립하므로
 * 로케일 표시 순서에 의존하지 않는다. */
export function kstCivilDateString(instant: Date): string | null {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (!year || !month || !day) return null;
  return civilToString({ year: Number(year), month: Number(month), day: Number(day) });
}

/** 유효한 실제 달력 날짜만 수용 (2월 30일 등 불가). */
export function parseCivilDate(value: string): CivilDate | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (date.month < 1 || date.month > 12 || date.year < 1 || date.year > 9999) return null;
  if (date.day < 1 || date.day > lastDayOfMonth(date.year, date.month)) return null;
  return date;
}

export function civilToString(date: CivilDate): string | null {
  if (date.year < 1 || date.year > 9999) return null;
  const value = `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  return parseCivilDate(value) ? value : null;
}

export function lastDayOfMonth(year: number, month: number): number {
  // 다음 달 0일 = 이번 달 마지막 날. UTC 보정 캘린더 산술(호스트 TZ 무관).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 캘린더 일 더하기/빼기. 지원 범위(1~9999년)를 벗어나면 null. */
export function addCivilDays(value: string, days: number): string | null {
  const date = parseCivilDate(value);
  if (!date || !Number.isInteger(days)) return null;
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  const year = shifted.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  return civilToString({ year, month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() });
}

/** ISO 요일: 월요일=1 … 일요일=7. */
export function isoWeekdayOf(value: string): number | null {
  const date = parseCivilDate(value);
  if (!date) return null;
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() || 7;
}

/** 해당 날짜가 속한 주(weekStartDay 요일 시작)의 첫 날짜. weekStart ≤ 9999-12-25
 * (shared 스키마 상한)를 만족하는 것만 반환한다. */
export function weekStartFor(value: string, weekStartDay: number): string | null {
  const weekday = isoWeekdayOf(value);
  if (weekday === null || weekStartDay < 1 || weekStartDay > 7) return null;
  const start = addCivilDays(value, -((weekday - weekStartDay + 7) % 7));
  if (!start || start > "9999-12-25") return null;
  return start;
}

/** 31일 급여일 같은 "일(number)"를 해당 월에 clamp (2월/윤년 대응). */
export function clampDayToMonth(year: number, month: number, day: number): number {
  return Math.min(day, lastDayOfMonth(year, month));
}

/** [fromInclusive, toExclusive) 안에서 paydayDay(1..31, 월말 clamp)의 모든 실제
 * 발생일을 오름차순으로. 단기 주기에서 2회 발생을 놓치지 않도록 1개가 아니라
 * 전체를 세는다. */
export function paydayOccurrences(fromInclusive: string, toExclusive: string, paydayDay: number): string[] {
  const from = parseCivilDate(fromInclusive);
  const to = parseCivilDate(toExclusive);
  if (!from || !to || !Number.isInteger(paydayDay) || paydayDay < 1 || paydayDay > 31) return [];
  const occurrences: string[] = [];
  let year = from.year;
  let month = from.month;
  let guard = 0;
  while ((year < to.year || (year === to.year && month <= to.month)) && guard < 600) {
    guard += 1;
    const candidate = civilToString({ year, month, day: clampDayToMonth(year, month, paydayDay) });
    if (candidate && candidate >= fromInclusive && candidate < toExclusive) occurrences.push(candidate);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    if (year > 9999) break;
  }
  return occurrences;
}

/** "2026-10-19" → "10/19" 짧은 표시. */
export function formatCivilDateShort(value: string): string {
  const date = parseCivilDate(value);
  if (!date) return value;
  return `${date.month}/${date.day}`;
}
