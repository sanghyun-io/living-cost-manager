// 자연어 한 줄 입력에서 고정비 필드를 추출하는 규칙 기반 파서.
// 예: "넷플릭스 17000원 매달" → { name: "넷플릭스", amount: 17000, periodMonths: 1 }
//
// 외부 의존성 없는 순수 함수. categorize 와 독립적이며(categoryId 는 채우지
// 않는다), 호출 측이 필요하면 suggestCategoryId 와 조합한다.
// 추출 실패한 필드는 결과 객체에서 생략되어, 호출 측이 createFixedCost 의
// 기본값으로 폴백할 수 있다.

export type ParsedFixedCostInput = {
  /** 금액/주기 토큰을 제거하고 남은 항목명. 비면 생략. */
  name?: string;
  /** 원 단위 정수 금액. 추출 실패 시 생략. */
  amount?: number;
  /** 납부 주기(개월). "매달"=1, "매년"=12, "분기"=3 등. 실패 시 생략. */
  periodMonths?: number;
};

// "1만7천", "17,000", "17000원", "3.5만" 등을 정수 원으로 해석.
// 매칭된 텍스트 범위도 함께 돌려줘 name 에서 제거할 수 있게 한다.
type AmountMatch = { amount: number; matchedText: string };

const MAN = 10000; // 만
const CHEON = 1000; // 천

function parseAmount(text: string): AmountMatch | null {
  // 1) "1만7천", "3만", "5천" 같은 한글 단위 표기 (소수 만 단위도 허용: "3.5만")
  //    만/천 단위가 하나라도 있으면 우선 처리.
  const hangulUnit = text.match(/(\d+(?:\.\d+)?)\s*만\s*(?:(\d+(?:\.\d+)?)\s*천)?\s*원?|(\d+(?:\.\d+)?)\s*천\s*원?/);
  if (hangulUnit) {
    let amount = 0;
    if (hangulUnit[1] !== undefined) {
      // "N만" (+ 선택적 "M천")
      amount += Math.round(parseFloat(hangulUnit[1]) * MAN);
      if (hangulUnit[2] !== undefined) {
        amount += Math.round(parseFloat(hangulUnit[2]) * CHEON);
      }
    } else if (hangulUnit[3] !== undefined) {
      // "N천"
      amount += Math.round(parseFloat(hangulUnit[3]) * CHEON);
    }
    if (amount > 0) {
      return { amount, matchedText: hangulUnit[0] };
    }
  }

  // 2) 순수 숫자(쉼표 허용) + 선택적 "원". 예: "17,000원", "17000".
  const numeric = text.match(/(\d[\d,]*)\s*원?/);
  if (numeric) {
    const digits = numeric[1].replace(/,/g, "");
    const amount = Number.parseInt(digits, 10);
    if (Number.isFinite(amount) && amount > 0) {
      return { amount, matchedText: numeric[0] };
    }
  }

  return null;
}

// 주기 키워드 → 개월. 매칭된 텍스트도 돌려줘 name 에서 제거.
type PeriodMatch = { periodMonths: number; matchedText: string };

const PERIOD_RULES: ReadonlyArray<{ pattern: RegExp; months: number }> = [
  { pattern: /매달|매월|월마다|한\s*달에\s*한\s*번|monthly/i, months: 1 },
  { pattern: /매년|매해|연마다|일\s*년에\s*한\s*번|yearly|annually/i, months: 12 },
  { pattern: /반기|반\s*년마다|6개월마다/i, months: 6 },
  { pattern: /분기|분기마다|3개월마다|quarterly/i, months: 3 },
  // "N개월마다" / "N개월에 한 번" 같은 명시적 표기 (가장 마지막에 평가)
];

function parsePeriod(text: string): PeriodMatch | null {
  // 명시적 "N개월" 표기 우선
  const explicit = text.match(/(\d+(?:\.\d+)?)\s*개월\s*(?:마다|에\s*한\s*번)?/);
  if (explicit) {
    const months = Math.round(parseFloat(explicit[1]) * 10) / 10;
    if (months > 0) {
      return { periodMonths: months, matchedText: explicit[0] };
    }
  }
  for (const rule of PERIOD_RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      return { periodMonths: rule.months, matchedText: m[0] };
    }
  }
  return null;
}

/**
 * 자연어 한 줄을 파싱한다. 추출 가능한 필드만 채운 부분 객체를 반환한다.
 * name 은 금액/주기로 인식된 토큰을 제거한 나머지 텍스트다.
 */
export function parseFixedCostInput(input: string): ParsedFixedCostInput {
  const raw = input.trim();
  const result: ParsedFixedCostInput = {};
  if (raw.length === 0) {
    return result;
  }

  // name 에서 깎아낼 구간을 기록하기 위해, 매칭 텍스트를 순서대로 제거한다.
  // 주기를 먼저 파싱한다 — "6개월에 한 번"의 "6"이 금액으로 오인되지 않도록
  // 주기 토큰을 remainder 에서 먼저 제거한 뒤 금액을 찾는다.
  let remainder = raw;

  const periodMatch = parsePeriod(remainder);
  if (periodMatch) {
    result.periodMonths = periodMatch.periodMonths;
    remainder = removeFirst(remainder, periodMatch.matchedText);
  }

  const amountMatch = parseAmount(remainder);
  if (amountMatch) {
    result.amount = amountMatch.amount;
    remainder = removeFirst(remainder, amountMatch.matchedText);
  }

  const name = remainder.replace(/\s+/g, " ").trim();
  if (name.length > 0) {
    result.name = name;
  }

  return result;
}

function removeFirst(text: string, fragment: string): string {
  const index = text.indexOf(fragment);
  if (index < 0) {
    return text;
  }
  return text.slice(0, index) + text.slice(index + fragment.length);
}
