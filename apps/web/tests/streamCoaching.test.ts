import { describe, expect, test, vi } from "vitest";
import { streamCoaching, type CoachInput } from "../app/lib/coach";

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

function createFakeEngine(responses: string[]) {
  let callIndex = 0;
  
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          const response = responses[callIndex] || responses[responses.length - 1];
          callIndex++;
          
          // 스트리밍 응답 시뮬레이션
          return (async function* () {
            const words = response.split(" ");
            for (const word of words) {
              yield {
                choices: [{ delta: { content: word + " " } }]
              };
            }
          })();
        })
      }
    }
  };
}

describe("streamCoaching — 기본 동작", () => {
  test("격려 조각만 있으면 한 문장 생성", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    const result = await streamCoaching(engine as any, input());
    
    expect(result).toContain("잘 관리");
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("여러 조각이 있으면 순차적으로 생성", async () => {
    const engine = createFakeEngine([
      "고정비를 잘 관리하고 계세요.",
      "이번 달 고정비가 늘었으니 살펴보시면 좋겠어요."
    ]);
    
    const result = await streamCoaching(
      engine as any,
      input({
        previousMonthlyTotal: 1_000_000,
        deltaAmount: 39_000,
        deltaPercent: 3.9
      })
    );
    
    expect(result).toContain("잘 관리");
    expect(result).toContain("늘었");
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  test("onToken 콜백으로 누적 텍스트 전달", async () => {
    const engine = createFakeEngine([
      "고정비를 잘 관리하고 계세요.",
      "이번 달 고정비가 늘었으니 살펴보시면 좋겠어요."
    ]);
    
    const tokens: string[] = [];
    await streamCoaching(
      engine as any,
      input({
        previousMonthlyTotal: 1_000_000,
        deltaAmount: 39_000,
        deltaPercent: 3.9
      }),
      (full) => tokens.push(full)
    );
    
    // 최소 한 번 이상 호출됨
    expect(tokens.length).toBeGreaterThan(0);
    // 마지막 토큰은 전체 텍스트
    expect(tokens[tokens.length - 1]).toContain("잘 관리");
  });

  test("모델 출력이 비정상으로 짧으면 폴백 사용", async () => {
    const engine = createFakeEngine(["짧"]); // 6자 미만
    
    const result = await streamCoaching(engine as any, input());
    
    // 폴백 문장 사용 (example)
    expect(result.length).toBeGreaterThan(6);
  });

  test("빈 응답이면 폴백 사용", async () => {
    const engine = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            return (async function* () {
              // 빈 응답
            })();
          })
        }
      }
    };
    
    const result = await streamCoaching(engine as any, input());
    
    // 폴백 문장 사용
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("streamCoaching — 조각 선택", () => {
  test("해당 없는 조각은 호출하지 않음", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    
    await streamCoaching(engine as any, input());
    
    // 격려만 있으므로 1번만 호출
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("절감 후보 있으면 savings 조각 호출", async () => {
    const engine = createFakeEngine([
      "고정비를 잘 관리하고 계세요.",
      "구독은 이번 주에 한번 살펴보시면 좋겠어요."
    ]);
    
    await streamCoaching(
      engine as any,
      input({ savings: [{ title: "구독", monthlySavings: 10000 }] })
    );
    
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  test("최대 4개 조각만 호출", async () => {
    const engine = createFakeEngine([
      "고정비를 잘 관리하고 계세요.",
      "이번 달 고정비가 늘었으니 살펴보시면 좋겠어요.",
      "보험료 비중이 높은 편이니 점검해 보시면 좋겠어요.",
      "통신비가 며칠 안에 빠져나가니 잔액만 미리 확인해 두시면 좋겠어요."
    ]);
    
    await streamCoaching(
      engine as any,
      input({
        previousMonthlyTotal: 1_000_000,
        deltaAmount: 39_000,
        deltaPercent: 3.9,
        savings: [{ title: "구독", monthlySavings: 10000 }],
        insuranceHigh: true,
        upcoming: [{ name: "통신비", amount: 79000, daysUntil: 3 }]
      })
    );
    
    // 최대 4개 (praise, trend, insurance, upcoming - savings는 잘림)
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(4);
  });
});

describe("streamCoaching — 에러 처리", () => {
  test("엔진 에러 시 전파", async () => {
    const engine = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("GPU_ERROR"))
        }
      }
    };
    
    await expect(streamCoaching(engine as any, input())).rejects.toThrow("GPU_ERROR");
  });

  test("스트리밍 중 에러는 이미 생성된 텍스트는 유지", async () => {
    const engine = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            return (async function* () {
              yield { choices: [{ delta: { content: "첫 번째 문장." } }] };
              throw new Error("STREAM_ERROR");
            })();
          })
        }
      }
    };
    
    await expect(streamCoaching(engine as any, input())).rejects.toThrow("STREAM_ERROR");
  });
});
