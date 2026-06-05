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

// 결정적 데이터를 한국어 컨텍스트 문자열로 직렬화한다(모델 입력).
export function buildCoachContext(input: CoachInput): string {
  const lines: string[] = [];
  lines.push(`월 수입: ${won(input.monthlyIncome)}`);
  lines.push(
    `이번 달 월 환산 고정비: ${won(input.monthlyTotal)} (${input.fixedCostCount}건)`
  );
  if (input.previousMonthlyTotal !== null && input.deltaAmount !== null) {
    const dir = input.deltaAmount > 0 ? "증가" : input.deltaAmount < 0 ? "감소" : "동일";
    const pct = input.deltaPercent !== null ? ` (${input.deltaPercent}%)` : "";
    lines.push(
      `지난달 대비: ${won(Math.abs(input.deltaAmount))} ${dir}${pct} [지난달 ${won(input.previousMonthlyTotal)}]`
    );
  }
  if (input.monthlyIncome > 0) {
    const rate = Math.round((input.monthlyTotal / input.monthlyIncome) * 1000) / 10;
    lines.push(`수입 대비 고정비 비율: ${rate}%`);
  }
  if (input.savings.length > 0) {
    lines.push(
      "절감 후보: " +
        input.savings
          .map((s) => `${s.title}(월 ${won(s.monthlySavings)} 절감 가능)`)
          .join(", ")
    );
  }
  if (input.upcoming.length > 0) {
    lines.push(
      "임박 납부: " +
        input.upcoming
          .map((u) => `${u.name} ${won(u.amount)} (${u.daysUntil}일 후)`)
          .join(", ")
    );
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = [
  "당신은 한국어로 답하는 친근한 가계부 코치입니다.",
  "사용자의 고정비 데이터를 보고 따뜻하고 구체적인 조언을 2~3문장으로 해주세요.",
  "규칙:",
  "- 반드시 한국어로, 존댓말로 답합니다.",
  "- 제공된 숫자만 사용하고 새로운 수치를 지어내지 않습니다.",
  "- 비난하지 않고 실천 가능한 제안 1가지를 포함합니다.",
  "- 마크다운 없이 자연스러운 문장으로만 씁니다."
].join("\n");

export function buildCoachMessages(input: CoachInput) {
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "user" as const,
      content:
        "다음은 제 이번 달 고정비 요약이에요. 코칭 한마디 부탁해요.\n\n" +
        buildCoachContext(input)
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
    temperature: 0.7,
    max_tokens: 220,
    stream: true
  });

  let full = "";
  for await (const chunk of chunks) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      full += delta;
      onToken?.(full);
    }
  }
  return full.trim();
}
