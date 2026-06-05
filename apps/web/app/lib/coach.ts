// 온디바이스 LLM 코치 — WebLLM 엔진 로드 + 프롬프트 빌더 + 스트리밍 추론.
//
// 모든 추론은 사용자 브라우저(WebGPU)에서 실행된다. 가계부 데이터는 절대
// 외부로 나가지 않는다(프라이버시). 입력은 shared 의 결정적 함수
// (buildMonthlyReport / buildSavingsInsights / getUpcomingDues)로 미리 계산한
// 요약을 받아, 그 위에 자연어 코칭 한두 문단을 얹는 얇은 레이어다.

import type {
  CreateMLCEngine as CreateMLCEngineType,
  MLCEngineInterface,
  InitProgressReport
} from "@mlc-ai/web-llm";

import {
  COACH_MODEL_ID,
  getCoachModelBaseUrl,
  isWebGpuAvailable
} from "./coachModel";

// 코치에게 넘기는 요약 입력. page 에서 shared 함수로 계산해 전달한다.
export type CoachInput = {
  // 이번 달 / 지난달 월 환산 고정비와 증감(buildMonthlyReport 결과 요약).
  monthlyTotal: number;
  previousMonthlyTotal: number | null;
  deltaAmount: number | null;
  deltaPercent: number | null;
  monthlyIncome: number;
  fixedCostCount: number;
  // 절감 인사이트(중복 구독·최대 항목 등) 제목 + 월 절감액.
  savings: Array<{ title: string; monthlySavings: number }>;
  // 14일 내 임박 납부(이름 + 금액 + N일 후).
  upcoming: Array<{ name: string; amount: number; daysUntil: number }>;
};

function won(n: number): string {
  return `${Math.round(n).toLocaleString("ko-KR")}원`;
}

// 결정적 데이터를 한국어 "문장"으로 직렬화한다(모델 입력).
// 0.5B 같은 작은 모델은 입력 형식을 그대로 모방하는 경향이 강하다. 표(라벨:값)
// 형태로 주면 출력도 표/나열로 나오므로, 일부러 자연스러운 서술문으로 풀어
// 모델이 문장체 조언을 내도록 유도한다.
export function buildCoachContext(input: CoachInput): string {
  const lines: string[] = [];

  if (input.monthlyIncome > 0) {
    const rate = Math.round((input.monthlyTotal / input.monthlyIncome) * 1000) / 10;
    lines.push(
      `이번 달 월 환산 고정비는 ${won(input.monthlyTotal)}으로, 항목 ${input.fixedCostCount}건이고 월 수입 ${won(input.monthlyIncome)}의 ${rate}%를 차지해요.`
    );
  } else {
    lines.push(
      `이번 달 월 환산 고정비는 ${won(input.monthlyTotal)}으로, 항목은 ${input.fixedCostCount}건이에요.`
    );
  }

  if (input.previousMonthlyTotal !== null && input.deltaAmount !== null) {
    if (input.deltaAmount === 0) {
      lines.push("지난달과 고정비가 거의 같아요.");
    } else {
      const dir = input.deltaAmount > 0 ? "늘었어요" : "줄었어요";
      const pct = input.deltaPercent !== null ? ` (${input.deltaPercent}%)` : "";
      lines.push(`지난달보다 ${won(Math.abs(input.deltaAmount))}${pct} ${dir}.`);
    }
  }

  if (input.savings.length > 0) {
    const s = input.savings[0];
    lines.push(`눈여겨볼 만한 건 "${s.title}"으로, 손보면 월 ${won(s.monthlySavings)} 정도 아낄 수 있어요.`);
  }

  if (input.upcoming.length > 0) {
    const u = input.upcoming[0];
    const more = input.upcoming.length > 1 ? ` 외 ${input.upcoming.length - 1}건이 곧 빠져나가요` : "이 곧 빠져나가요";
    lines.push(`며칠 안에 ${u.name} ${won(u.amount)}(${u.daysUntil}일 후)${more}.`);
  }

  return lines.join(" ");
}

// 작은(0.5B) 모델은 긴 출력에서 반복·환각이 늘고, 목록형 입력을 목록으로
// 모방한다. 그래서 (1) 출력을 "정확히 2문장"으로 짧게 묶고, (2) "칭찬 1문장 +
// 조언 1문장"이라는 단순 구조를 못박고, (3) few-shot 2개로 서로 다른 상황을
// 보여줘 한 가지 패턴(예: '1건/2건/3건' 나열)을 모방하지 않게 한다.
const SYSTEM_PROMPT = [
  "당신은 한국어로 답하는 다정한 가계부 코치입니다.",
  "사용자의 상황을 듣고 '정확히 두 문장'으로만 코칭하세요.",
  "첫 문장은 따뜻한 격려, 둘째 문장은 바로 해볼 수 있는 구체적 제안 한 가지.",
  "규칙:",
  "- 한국어 존댓말, 부드러운 대화체. 두 문장을 넘기지 않습니다.",
  "- 숫자·항목을 나열하거나 목록/표를 만들지 않습니다. 받은 내용을 그대로 반복하지 않습니다.",
  "- 주어진 사실 안에서만 말하고, 없는 수치나 항목을 지어내지 않습니다.",
  "- 구체적인 금액(원)이나 퍼센트 숫자를 답에 쓰지 않습니다. 숫자 대신 '조금', '꽤', '가볍게' 같은 말로 표현합니다. (정확한 금액은 화면에 이미 보여요.)",
  "- 절감 제안은 입력에 '눈여겨볼 만한 건'으로 주어진 항목에 대해서만 합니다. 그 항목이 없으면 절감 얘기를 꺼내지 않습니다.",
  "- 월세·전세·보험처럼 줄이기 어려운 고정비는 '줄이라'고 하지 않습니다. 구독·통신요금처럼 조정 가능한 항목 위주로 제안합니다.",
  "- 마크다운·머리말·접두어 없이 코칭 두 문장만 출력합니다."
].join("\n");

// few-shot 2개 — 절감 후보가 있을 때 / 없을 때. 서로 다른 형태를 보여줘 모델이
// 한 가지 출력 패턴에 고착되지 않게 한다. 둘 다 "격려 + 제안" 2문장 구조.
const FEWSHOTS: Array<{ user: string; assistant: string }> = [
  {
    user:
      "이번 달 월 환산 고정비는 1,200,000원으로, 항목 4건이고 월 수입 4,000,000원의 30%를 차지해요. 눈여겨볼 만한 건 \"중복 구독\"으로, 손보면 월 20,000원 정도 아낄 수 있어요.",
    assistant:
      "고정비를 수입의 알맞은 선에서 안정적으로 관리하고 계세요. 이번 주에 겹치는 구독 하나만 정리해 보시면 매달 조금씩 가볍게 아낄 수 있어요."
  },
  {
    user:
      "이번 달 월 환산 고정비는 539,000원으로, 항목은 5건이고 월 수입 3,000,000원의 18%를 차지해요. 며칠 안에 통신비 79,000원(5일 후) 외 2건이 곧 빠져나가요.",
    assistant:
      "수입 대비 고정비 비중이 낮아서 살림을 단단하게 꾸리고 계시네요. 곧 통신비가 빠져나가니 잔액만 미리 확인해 두시면 마음 편히 넘어가실 거예요."
  }
];

export function buildCoachMessages(input: CoachInput) {
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...FEWSHOTS.flatMap((ex) => [
      { role: "user" as const, content: ex.user },
      { role: "assistant" as const, content: ex.assistant }
    ]),
    {
      role: "user" as const,
      content: buildCoachContext(input)
    }
  ];
}

// ── 엔진 로드 (lazy, 싱글톤) ─────────────────────────────────────────────────
let enginePromise: Promise<MLCEngineInterface> | null = null;

export type LoadProgress = { progress: number; text: string };

/**
 * WebLLM 엔진을 lazy 로드한다. 최초 1회만 가중치를 내려받고(진행률 콜백),
 * 이후엔 Cache/IndexedDB 에서 즉시 로드된다. R2 베이스 URL 이 설정돼 있으면
 * 그 URL 에서 가중치를 받는다(없으면 WebLLM 기본 CDN).
 */
export async function getCoachEngine(
  onProgress?: (p: LoadProgress) => void
): Promise<MLCEngineInterface> {
  if (!isWebGpuAvailable()) {
    throw new Error("WEBGPU_UNAVAILABLE");
  }
  if (enginePromise) {
    return enginePromise;
  }

  enginePromise = (async () => {
    // 동적 import — WebLLM 번들은 코치를 켤 때만 로드한다(초기 페이지 가볍게).
    const webllm = await import("@mlc-ai/web-llm");
    const CreateMLCEngine = webllm.CreateMLCEngine as typeof CreateMLCEngineType;

    // R2 호스팅 시 prebuilt 모델의 가중치 URL 만 우리 버킷으로 덮어쓴다.
    const baseUrl = getCoachModelBaseUrl();
    const appConfig = baseUrl
      ? overrideModelUrl(webllm.prebuiltAppConfig, COACH_MODEL_ID, baseUrl)
      : undefined;

    return CreateMLCEngine(COACH_MODEL_ID, {
      appConfig,
      initProgressCallback: (report: InitProgressReport) => {
        onProgress?.({ progress: report.progress, text: report.text });
      }
    });
  })();

  try {
    return await enginePromise;
  } catch (error) {
    // 실패 시 다음 시도에서 재로드 가능하도록 캐시를 비운다.
    enginePromise = null;
    throw error;
  }
}

// prebuiltAppConfig 를 복제해 대상 모델의 가중치(`model`) URL 만 교체한다.
function overrideModelUrl(
  prebuilt: typeof import("@mlc-ai/web-llm").prebuiltAppConfig,
  modelId: string,
  baseUrl: string
) {
  return {
    ...prebuilt,
    model_list: prebuilt.model_list.map((m) =>
      m.model_id === modelId ? { ...m, model: baseUrl } : m
    )
  };
}

/**
 * 코칭 멘트를 스트리밍 생성한다. onToken 으로 부분 응답을 흘려보낸다.
 * 전체 응답 문자열을 반환한다.
 */
export async function streamCoaching(
  engine: MLCEngineInterface,
  input: CoachInput,
  onToken?: (full: string) => void
): Promise<string> {
  const chunks = await engine.chat.completions.create({
    messages: buildCoachMessages(input),
    // 코치는 "주어진 데이터로만 말하는" RAG형 작업이다. 작은 모델에서 temp 가
    // 높으면 환각이 급증하므로 낮게(0.3) 잡아 사실에 붙인다.
    temperature: 0.3,
    top_p: 0.9,
    // 반복("1건/2건/3건 ...") 억제 — frequency 는 같은 토큰, presence 는 같은
    // 주제 반복을 누른다(OpenAI 의미, [-2,2]).
    frequency_penalty: 0.6,
    presence_penalty: 0.4,
    max_tokens: 160,
    stream: true
  });

  let raw = "";
  for await (const chunk of chunks) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      raw += delta;
      // 스트리밍 중에도 2문장으로 잘라 보여준다 — 작은 모델이 2문장 뒤로
      // 환각 계산식·목록을 덧붙여도 사용자에게는 노출되지 않는다.
      onToken?.(clampToTwoSentences(raw));
    }
  }
  return clampToTwoSentences(raw);
}

// 작은 모델은 "2문장만"을 자주 못 지키고 뒤에 계산식/목록 환각을 덧붙인다.
// 출력 안정화를 위해 앞 2문장만 취한다(목록 글머리 줄은 문장으로 안 침).
export function clampToTwoSentences(text: string): string {
  // 줄바꿈 이후의 목록/계산식 꼬리는 통째로 버린다(보통 환각이 여기서 시작).
  const firstBlock = text.split(/\n/)[0]?.trim() ?? "";
  const base = firstBlock.length > 0 ? firstBlock : text.trim();
  // 마침표/물음표/느낌표 기준 최대 2문장.
  const matches = base.match(/[^.!?。]*[.!?。]/g);
  if (!matches || matches.length === 0) {
    return base;
  }
  return matches.slice(0, 2).join("").trim();
}
