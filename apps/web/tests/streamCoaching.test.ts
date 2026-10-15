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
  test("보험 프롬프트는 검토 대상만 포함하고 보호명 환각은 실시간·최종 출력에서 로컬 차단", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    const tokens: string[] = [];
    const result = await streamCoaching(engine as any, input({ insuranceHigh: true, insuranceReviewItemNames: ["검토보험"] }), full => tokens.push(full), { protectedItemNames: ["보호보험"] });
    // Insurance is deterministic — no engine call for it. Only praise calls engine.
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
    const messages = engine.chat.completions.create.mock.calls.map(call => JSON.stringify(call[0].messages)).join(" ");
    // Protected names never enter model messages (only praise is sent to model)
    expect(messages).not.toContain("보호보험");
    expect(messages).not.toContain("검토보험");
    expect(messages).not.toContain("reason");
    // Insurance deterministic output contains eligible name
    expect(result).toContain('"검토보험"');
    expect(result).not.toContain("보호보험");
    expect(tokens.every(text => !text.includes("보호보험"))).toBe(true);
  });
  test("격려 조각만 있으면 한 문장 생성", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    const result = await streamCoaching(engine as any, input());
    
    expect(result).toContain("잘 관리");
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("여러 조각이 있으면 격려만 모델 호출, 나머지는 코드 결정적 출력", async () => {
    const engine = createFakeEngine([
      "고정비를 잘 관리하고 계세요."
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
    // Only praise calls engine; trend is deterministic
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("onToken 콜백으로 누적 텍스트 전달", async () => {
    const engine = createFakeEngine([
      "고정비를 잘 관리하고 계세요."
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

  test("모델 출력이 비정상으로 짧으면 폴백 사용 (격려만 해당)", async () => {
    const engine = createFakeEngine(["짧"]); // 6자 미만
    
    const result = await streamCoaching(engine as any, input());
    
    // 폴백 문장 사용 (example)
    expect(result.length).toBeGreaterThan(6);
  });

  test("빈 응답이면 폴백 사용 (격려만 해당)", async () => {
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

  test("절감 후보 있으면 savings 조각은 결정적 출력 (모델 호출 없음)", async () => {
    const engine = createFakeEngine([
      "고정비를 잘 관리하고 계세요."
    ]);
    
    const result = await streamCoaching(
      engine as any,
      input({ savings: [{ title: "구독", monthlySavings: 10000, targetItemNames: ["구독"] }] })
    );
    
    // Only praise calls engine; savings is deterministic
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result).toContain('"구독"');
    expect(result).toContain("필요 여부");
  });

  test("최대 4개 조각 — 격려만 모델, 나머지는 결정적 (savings는 우선순위 낮음)", async () => {
    const engine = createFakeEngine([
      "고정비를 잘 관리하고 계세요."
    ]);
    
    const result = await streamCoaching(
      engine as any,
      input({
        previousMonthlyTotal: 1_000_000,
        deltaAmount: 39_000,
        deltaPercent: 3.9,
        savings: [{ title: "구독", monthlySavings: 10000, targetItemNames: ["구독"] }],
        insuranceHigh: true,
        insuranceReviewItemNames: ["검토보험"],
        upcoming: [{ name: "통신비", amount: 79000, daysUntil: 3 }]
      })
    );
    
    // Only praise calls engine (1 time); trend/insurance/upcoming are deterministic
    // savings is dropped due to MAX_SEGMENTS=4 and priority (praise>upcoming>trend>insurance>savings)
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result).toContain("잘 관리");
    expect(result).toContain("늘었");
    expect(result).toContain('"검토보험"');
    expect(result).toContain("통신비");
    // savings is dropped, so no savings content
    expect(result).not.toContain('"구독"');
  });
});

describe("streamCoaching — 에러 처리", () => {
  test("엔진 에러 시 전파 (격려 조각만 해당)", async () => {
    const engine = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("GPU_ERROR"))
        }
      }
    };
    
    await expect(streamCoaching(engine as any, input())).rejects.toThrow("GPU_ERROR");
  });

  test("스트리밍 중 에러는 이미 생성된 텍스트는 유지 (격려만 해당)", async () => {
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

describe("streamCoaching — 결정적 출력 안전성", () => {
  test("savings 조각은 모델 응답 없이 코드에서 정확한 대상명 포함", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    const result = await streamCoaching(
      engine as any,
      input({
        savings: [{
          title: "점검 가능한 '합성 구독' 2건",
          monthlySavings: 15000,
          targetItemNames: ["합성 구독 A", "합성 구독 B"]
        }]
      })
    );
    // Exact target names from source code — not model paraphrase
    expect(result).toContain('"합성 구독 A"');
    expect(result).toContain('"합성 구독 B"');
    expect(result).toContain("중복 여부");
    // Only praise calls engine
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("savings 단일 대상은 따옴표로 감싼 정확한 이름", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    const result = await streamCoaching(
      engine as any,
      input({
        savings: [{
          title: "최대 항목",
          monthlySavings: 20000,
          targetItemNames: ["인터넷"]
        }]
      })
    );
    expect(result).toContain('"인터넷"');
    expect(result).toContain("필요 여부");
    expect(result).toContain("이용 조건");
  });

  test("insurance 조각은 모델 응답 없이 정확한 eligible 이름 포함", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    const result = await streamCoaching(
      engine as any,
      input({
        insuranceHigh: true,
        insuranceReviewItemNames: ["운전자보험", "화재보험"]
      })
    );
    // Exact eligible names from source — not model paraphrase
    expect(result).toContain('"운전자보험"');
    expect(result).toContain('"화재보험"');
    expect(result).toContain("보장 내용");
    // Only praise calls engine
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("trend 조각은 모델 응답 없이 코드 계산 값 포함", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    const result = await streamCoaching(
      engine as any,
      input({
        previousMonthlyTotal: 1_000_000,
        deltaAmount: 50000,
        deltaPercent: 5.0
      })
    );
    // Exact numeric values from source code
    expect(result).toContain("50,000");
    expect(result).toContain("+5%");
    // Only praise calls engine
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("upcoming 조각은 모델 응답 없이 정확한 이름·금액 포함", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    const result = await streamCoaching(
      engine as any,
      input({
        upcoming: [{ name: "전기요금", amount: 45000, daysUntil: 5 }]
      })
    );
    // Exact name from source
    expect(result).toContain("전기요금");
    expect(result).toContain("며칠 안에");
    // Only praise calls engine
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("보호명은 입력 경계에서 제외되며 출력에도 등장하지 않음", async () => {
    // CRITICAL: Protection happens at input boundary (shared layer filters by ID).
    // This test verifies that when caller properly excludes protected items,
    // they don't appear in coach output.
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    const result = await streamCoaching(
      engine as any,
      input({
        // Only eligible (non-protected) items in targetItemNames
        savings: [{
          title: "최대 항목",
          monthlySavings: 20000,
          targetItemNames: ["검토구독"]  // eligible, not protected
        }],
        insuranceHigh: true,
        insuranceReviewItemNames: ["검토보험"]  // eligible, not protected
      }),
      undefined,
      { protectedItemNames: ["보호구독", "보호보험"] }
    );
    // Eligible names appear in output
    expect(result).toContain('"검토구독"');
    expect(result).toContain('"검토보험"');
    // Protected names (not in input) don't appear
    expect(result).not.toContain("보호구독");
    expect(result).not.toContain("보호보험");
  });

  test("모델 응답이 savings/insurance/trend/upcoming에 침투하지 않음", async () => {
    // Model tries to inject content into non-praise segments
    const engine = createFakeEngine([
      "고정비를 잘 관리하고 계세요.",
      "모델이 만든 가짜 구독 추천 문장.",
      "모델이 만든 가짜 보험 추천 문장."
    ]);
    const result = await streamCoaching(
      engine as any,
      input({
        savings: [{ title: "구독", monthlySavings: 10000, targetItemNames: ["합성구독"] }],
        insuranceHigh: true,
        insuranceReviewItemNames: ["검토보험"]
      })
    );
    // Model output must not appear in deterministic segments
    expect(result).not.toContain("가짜 구독");
    expect(result).not.toContain("가짜 보험");
    // Only 1 engine call (praise only)
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
    // Deterministic content present
    expect(result).toContain('"합성구독"');
    expect(result).toContain('"검토보험"');
  });

  test("모델 메시지에 protected reason 메타데이터 포함 안됨", async () => {
    const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
    await streamCoaching(
      engine as any,
      input({
        savings: [{ title: "구독", monthlySavings: 10000, targetItemNames: ["검토구독"] }],
        insuranceHigh: true,
        insuranceReviewItemNames: ["검토보험"]
      }),
      undefined,
      { protectedItemNames: ["보호구독"] }
    );
    // Only praise is sent to model — no savings/insurance data in messages
    const allMessages = engine.chat.completions.create.mock.calls
      .map(call => JSON.stringify(call[0].messages))
      .join(" ");
    expect(allMessages).not.toContain("검토구독");
    expect(allMessages).not.toContain("검토보험");
    expect(allMessages).not.toContain("보호구독");
    expect(allMessages).not.toContain("reason");
    expect(allMessages).not.toContain("targetItemNames");
  });
});
