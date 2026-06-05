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
