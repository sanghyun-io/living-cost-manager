import { describe, expect, test } from "vitest";

import { clampToOneSentence, selectCoachSegments, type CoachInput } from "../app/lib/coach";

// 조각 선정은 순수 함수다(LLM·WebGPU 불필요). coach.ts 상단은 `import type` 으로만
// web-llm 을 참조하므로 이 테스트가 런타임 모델을 로드하지 않는다.

function input(partial: Partial<CoachInput> = {}): CoachInput {
  return {
    monthlyTotal: 1_039_000,
    previousMonthlyTotal: null,
    deltaAmount: null,
    deltaPercent: null,
    monthlyIncome: 3_000_000,
    fixedCostCount: 5,
    savings: [],
    upcoming: [],
    insuranceHigh: false,
    ...partial
  };
}

function keys(input: CoachInput): string[] {
  return selectCoachSegments(input).map((s) => s.key);
}

describe("selectCoachSegments — 조합", () => {
  test("격려는 항상 포함되고 맨 앞", () => {
    expect(keys(input())[0]).toBe("praise");
  });

  test("기본(절감·보험·임박 없음)은 격려 1개만", () => {
    expect(keys(input())).toEqual(["praise"]);
  });

  test("절감 후보 있으면 savings 추가", () => {
    const k = keys(input({ savings: [{ title: "넷플릭스", monthlySavings: 17000 }] }));
    expect(k).toContain("savings");
  });

  test("보험 비중 높으면 insurance 추가", () => {
    expect(keys(input({ insuranceHigh: true }))).toContain("insurance");
  });

  test("임박 납부 있으면 upcoming 추가", () => {
    const k = keys(input({ upcoming: [{ name: "통신비", amount: 79000, daysUntil: 5 }] }));
    expect(k).toContain("upcoming");
  });

  test("모두 겹치면 4개 조각, 순서는 격려→절감→보험→임박", () => {
    const k = keys(
      input({
        savings: [{ title: "구독", monthlySavings: 10000 }],
        insuranceHigh: true,
        upcoming: [{ name: "통신비", amount: 79000, daysUntil: 3 }]
      })
    );
    expect(k).toEqual(["praise", "savings", "insurance", "upcoming"]);
  });

  test("항목 0개여도 격려는 나오고 깨지지 않음", () => {
    const k = keys(input({ fixedCostCount: 0, monthlyTotal: 0 }));
    expect(k).toEqual(["praise"]);
  });

  test("수입 0이어도 안전하게 격려 1개", () => {
    const segments = selectCoachSegments(input({ monthlyIncome: 0 }));
    expect(segments).toHaveLength(1);
    expect(segments[0].example.length).toBeGreaterThan(0);
  });

  test("모든 조각의 example 은 비어있지 않다(폴백 안전)", () => {
    const segments = selectCoachSegments(
      input({
        savings: [{ title: "구독", monthlySavings: 10000 }],
        insuranceHigh: true,
        upcoming: [{ name: "통신비", amount: 79000, daysUntil: 3 }]
      })
    );
    for (const s of segments) {
      expect(s.example.trim().length).toBeGreaterThan(5);
    }
  });

  test("추세 데이터 없으면(previous null) trend 조각 없음", () => {
    expect(keys(input())).not.toContain("trend");
  });

  test("지난달 대비 데이터 있으면 trend 추가되고 격려 바로 뒤", () => {
    const k = keys(
      input({ previousMonthlyTotal: 1_000_000, deltaAmount: 39_000, deltaPercent: 3.9 })
    );
    expect(k).toContain("trend");
    expect(k.indexOf("trend")).toBe(1);
  });

  test("고정비 증가 시 trend 문장에 '늘었'과 금액·퍼센트 포함", () => {
    const seg = selectCoachSegments(
      input({ previousMonthlyTotal: 1_000_000, deltaAmount: 39_000, deltaPercent: 3.9 })
    ).find((s) => s.key === "trend");
    expect(seg?.example).toContain("늘었");
    expect(seg?.example).toContain("39,000원");
    expect(seg?.example).toContain("+3.9%");
  });

  test("고정비 감소 시 trend 문장에 '줄였'과 양수 금액 포함", () => {
    const seg = selectCoachSegments(
      input({ previousMonthlyTotal: 1_039_000, deltaAmount: -39_000, deltaPercent: -3.8 })
    ).find((s) => s.key === "trend");
    expect(seg?.example).toContain("줄였");
    expect(seg?.example).toContain("39,000원");
  });

  test("증감 0이면 trend 문장은 '비슷하게 유지'", () => {
    const seg = selectCoachSegments(
      input({ previousMonthlyTotal: 1_039_000, deltaAmount: 0, deltaPercent: 0 })
    ).find((s) => s.key === "trend");
    expect(seg?.example).toContain("비슷하게");
  });

  test("deltaPercent null 이어도(이전 0원) trend 는 금액만으로 안전 생성", () => {
    const seg = selectCoachSegments(
      input({ previousMonthlyTotal: 0, deltaAmount: 50_000, deltaPercent: null })
    ).find((s) => s.key === "trend");
    expect(seg?.example).toContain("50,000원");
    expect(seg?.example).not.toContain("%");
  });

  test("모든 관점이 켜져도 조각은 최대 4개로 제한된다", () => {
    const segments = selectCoachSegments(
      input({
        previousMonthlyTotal: 1_000_000,
        deltaAmount: 39_000,
        deltaPercent: 3.9,
        savings: [{ title: "구독", monthlySavings: 10000 }],
        insuranceHigh: true,
        upcoming: [{ name: "통신비", amount: 79000, daysUntil: 3 }]
      })
    );
    expect(segments.length).toBe(4);
  });

  test("상한 적용 시 격려는 항상 보존되고, 절감이 가장 먼저 잘린다", () => {
    // 5개 후보(praise/trend/savings/insurance/upcoming) → 4개로 컷.
    // 우선순위: praise > upcoming > trend > insurance > savings 이므로 savings 탈락.
    const k = keys(
      input({
        previousMonthlyTotal: 1_000_000,
        deltaAmount: 39_000,
        deltaPercent: 3.9,
        savings: [{ title: "구독", monthlySavings: 10000 }],
        insuranceHigh: true,
        upcoming: [{ name: "통신비", amount: 79000, daysUntil: 3 }]
      })
    );
    expect(k).toContain("praise");
    expect(k).not.toContain("savings");
    expect(k).toContain("upcoming");
    expect(k).toContain("trend");
    expect(k).toContain("insurance");
  });

  test("상한 후에도 등장 순서(흐름)는 보존된다", () => {
    // 남는 4개는 원래 순서 praise→trend→insurance→upcoming 를 유지해야 한다.
    const k = keys(
      input({
        previousMonthlyTotal: 1_000_000,
        deltaAmount: 39_000,
        deltaPercent: 3.9,
        savings: [{ title: "구독", monthlySavings: 10000 }],
        insuranceHigh: true,
        upcoming: [{ name: "통신비", amount: 79000, daysUntil: 3 }]
      })
    );
    expect(k).toEqual(["praise", "trend", "insurance", "upcoming"]);
  });

  test("임박 2건 이상이면 '외' 표현이 들어간다", () => {
    const segments = selectCoachSegments(
      input({
        upcoming: [
          { name: "통신비", amount: 79000, daysUntil: 3 },
          { name: "보험료", amount: 155000, daysUntil: 7 }
        ]
      })
    );
    const up = segments.find((s) => s.key === "upcoming");
    expect(up?.example).toContain("외");
  });
});

describe("clampToOneSentence", () => {
  test("첫 문장까지만 취한다", () => {
    expect(clampToOneSentence("좋아요. 그리고 또. 세번째.")).toBe("좋아요.");
  });

  test("줄바꿈 이후 꼬리는 버린다", () => {
    expect(clampToOneSentence("한 문장이에요.\n- 1건: 환각\n- 2건: 환각")).toBe("한 문장이에요.");
  });

  test("종결부호 없으면 통째로(앞 블록)", () => {
    expect(clampToOneSentence("종결부호 없는 문장")).toBe("종결부호 없는 문장");
  });

  test("물음표·느낌표도 문장 끝으로 인식", () => {
    expect(clampToOneSentence("괜찮으세요? 다음 문장.")).toBe("괜찮으세요?");
  });
});
