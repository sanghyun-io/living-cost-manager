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
  // 보험료가 수입 대비 과한지(휴리스틱). true 일 때만 코치가 보험 점검을 권한다.
  insuranceHigh: boolean;
};

function won(n: number): string {
  return `${Math.round(n).toLocaleString("ko-KR")}원`;
}

// ── 조각(segment) 기반 코칭 ─────────────────────────────────────────────────
// WebLLM 은 한 엔진에서 동시 추론이 안 된다(병렬 요청 시 출력이 섞임). 그래서
// "여러 관점을 한 번에" 대신, 관점마다 좁은 프롬프트로 1문장씩 '순차' 생성하고
// 코드가 이어붙인다. 작은(0.5B) 모델은 한 번에 한 가지만 시키면 누락·환각이
// 크게 준다. "무엇을 짚을지" 선정은 이미 shared 의 결정적 함수가 했고(환각 0),
// 여기서는 고른 조각마다 코멘트만 생성한다.

// 0.5B 에게 "자유 생성"을 시키면 환각이 난다. 대신 우리가 이미 가진 완성 문장
// (example)을 "같은 뜻으로 살짝만 바꿔 한 문장으로" 패러프레이즈하게 한다.
// 새 정보를 못 넣으므로 환각 여지가 거의 없고, 톤만 자연스러워진다.
const SEGMENT_RULES = [
  "당신은 한국어로 답하는 다정한 가계부 코치입니다.",
  "주어지는 '코치 문장'을 같은 뜻으로 자연스럽게 한 문장으로 바꿔 말하세요.",
  "규칙: 의미를 바꾸거나 새 내용을 더하지 않습니다. 숫자·퍼센트·금액·항목명을 새로 만들지 않습니다.",
  "부드러운 존댓말, 딱 한 문장. 목록·머리말·따옴표·접두어 없이 그 한 문장만 출력합니다."
].join("\n");

export type CoachSegment = {
  key: "praise" | "savings" | "insurance" | "upcoming";
  // 코드가 만든 완성 코칭 문장. 모델은 이걸 같은 뜻으로 패러프레이즈만 한다.
  // 모델 호출이 실패하면 이 문장을 그대로 폴백으로 쓴다(환각 0).
  example: string;
};

// 입력에서 "해당되는 조각만" 동적으로 만든다(없는 관점은 호출 자체를 건너뜀).
export function selectCoachSegments(input: CoachInput): CoachSegment[] {
  const segments: CoachSegment[] = [];

  // 각 조각의 example 은 코드가 만든 "완성 코칭 문장"이다. 모델은 이걸 같은
  // 뜻으로만 다듬으므로, 동적 정보(항목명·비중 톤)는 여기서 문장에 박아 둔다.

  // 1) 전체 격려 — 항상.
  const rate =
    input.monthlyIncome > 0
      ? Math.round((input.monthlyTotal / input.monthlyIncome) * 1000) / 10
      : null;
  const praise =
    rate !== null && rate <= 40
      ? "고정비를 수입의 낮은 선에서 알뜰하게 관리하고 계세요."
      : rate !== null && rate > 60
        ? "고정비가 조금 부담될 수 있는데도 항목을 잘 정리해 관리하고 계세요."
        : "고정비를 차곡차곡 정리해 두셔서 살림을 안정적으로 꾸려가고 계세요.";
  segments.push({ key: "praise", example: praise });

  // 2) 절감 조언 — 코드가 고른 절감 후보가 있을 때만.
  if (input.savings.length > 0) {
    segments.push({
      key: "savings",
      example: `${input.savings[0].title}은(는) 이번 주에 한번 살펴보시면 매달 조금씩 가볍게 아낄 수 있어요.`
    });
  }

  // 3) 보험 점검 — 보험 비중이 높을 때만(휴리스틱).
  if (input.insuranceHigh) {
    segments.push({
      key: "insurance",
      example: "보험료 비중이 평균보다 조금 높은 편이라, 지금 보장 내용이 나에게 꼭 맞는지 한번 점검해 보시면 좋겠어요."
    });
  }

  // 4) 임박 납부 — 14일 내 도래가 있을 때만.
  if (input.upcoming.length > 0) {
    const u = input.upcoming[0];
    const tail =
      input.upcoming.length > 1
        ? `${u.name} 외 몇 건이 며칠 안에 빠져나가니`
        : `${u.name}이(가) 며칠 안에 빠져나가니`;
    segments.push({
      key: "upcoming",
      example: `${tail} 잔액만 미리 확인해 두시면 마음 편히 넘어가실 거예요.`
    });
  }

  return segments;
}

function buildSegmentMessages(segment: CoachSegment) {
  return [
    { role: "system" as const, content: SEGMENT_RULES },
    // few-shot 1개 — "코치 문장 → 같은 뜻 한 문장" 패러프레이즈 시연.
    {
      role: "user" as const,
      content: "코치 문장: 고정비를 잘 정리해 두셔서 살림을 안정적으로 꾸리고 계세요."
    },
    {
      role: "assistant" as const,
      content: "고정비를 차곡차곡 정리해 두신 덕분에 살림을 안정적으로 꾸려가고 계세요."
    },
    { role: "user" as const, content: `코치 문장: ${segment.example}` }
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

// 한 조각을 1문장으로 생성한다(스트리밍, 1문장 컷).
async function generateSegment(
  engine: MLCEngineInterface,
  segment: CoachSegment,
  onPartial?: (sentence: string) => void
): Promise<string> {
  const chunks = await engine.chat.completions.create({
    messages: buildSegmentMessages(segment),
    // 패러프레이즈 작업이라 temp 를 아주 낮춰(0.2) 원문에 바싹 붙인다.
    temperature: 0.2,
    top_p: 0.9,
    frequency_penalty: 0.4,
    presence_penalty: 0.2,
    // 한 문장이라 토큰 상한을 짧게 둬 군더더기를 원천 차단.
    max_tokens: 70,
    stream: true
  });

  let raw = "";
  for await (const chunk of chunks) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      raw += delta;
      onPartial?.(clampToOneSentence(raw) || segment.example);
    }
  }
  const result = clampToOneSentence(raw);
  // 모델 출력이 비었거나 비정상으로 짧으면(패러프레이즈 실패) 원문 폴백.
  return result.length >= 6 ? result : segment.example;
}

/**
 * 코칭을 조각별로 '순차' 생성해 코드로 결합한다. onToken 으로 누적 결과를
 * 흘려보내(한 줄씩 채우기) 순차 대기 체감을 줄인다.
 *
 * WebLLM 은 동시 추론을 지원하지 않으므로 조각은 await 로 하나씩 처리한다.
 * 해당되는 조각만 호출하므로 보통 2~3회(격려 + 1~2개 조언)면 끝난다.
 */
export async function streamCoaching(
  engine: MLCEngineInterface,
  input: CoachInput,
  onToken?: (full: string) => void
): Promise<string> {
  const segments = selectCoachSegments(input);
  const done: string[] = [];

  for (const segment of segments) {
    // 진행 중 조각은 done(확정분) 뒤에 실시간으로 이어 붙여 표시한다.
    const sentence = await generateSegment(engine, segment, (partial) => {
      onToken?.([...done, partial].filter(Boolean).join(" "));
    });
    if (sentence) {
      done.push(sentence);
      onToken?.(done.join(" "));
    }
  }

  return done.join(" ");
}

// 작은 모델은 "한 문장만"을 자주 못 지키고 뒤에 군더더기를 덧붙인다.
// 첫 문장(첫 종결부호까지)만 취한다. 줄바꿈 이후 꼬리도 버린다.
export function clampToOneSentence(text: string): string {
  const firstBlock = text.split(/\n/)[0]?.trim() ?? "";
  const base = firstBlock.length > 0 ? firstBlock : text.trim();
  const matches = base.match(/[^.!?。]*[.!?。]/);
  return (matches ? matches[0] : base).trim();
}
