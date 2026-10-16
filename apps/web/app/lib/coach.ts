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
  COACH_MODEL_GENERATION,
  COACH_MODEL_ENABLE_THINKING,
  getCoachModelBaseUrl,
  isWebGpuAvailable
} from "./coachModel";

import {
  looksLikeUnfinishedThink,
  stripQwenThink
} from "./coachEngine/thinkPrefix";

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
  savings: Array<{
    title: string;
    monthlySavings: number;
    // CRITICAL: 액션 대상 항목명들 (보호 제외, 실제 존재). 모델에 의미 위임 금지.
    targetItemNames?: string[];
  }>;
  // 14일 내 임박 납부(이름 + 금액 + N일 후).
  upcoming: Array<{ name: string; amount: number; daysUntil: number }>;
  // 보험료가 수입 대비 과한지(휴리스틱). true 일 때만 코치가 보험 점검을 권한다.
  insuranceHigh: boolean;
  // 보험 점검 권유 대상 항목명들(보호 제외, 실제 존재). LLM에 안전하게 전달.
  insuranceReviewItemNames?: string[];
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
  key: "praise" | "trend" | "savings" | "insurance" | "upcoming";
  // 코드가 만든 완성 코칭 문장. 모델은 이걸 같은 뜻으로 패러프레이즈만 한다.
  // 모델 호출이 실패하면 이 문장을 그대로 폴백으로 쓴다(환각 0).
  example: string;
};

// 조각 수 상한 — 항목이 많아 모든 관점이 켜져도 코치 출력이 길어지지 않게
// 자른다. 격려는 항상 보존하고, 나머지는 아래 우선순위가 높은 것부터 채운다.
// 작은 모델이라 조각 하나당 한 문장이므로 4문장이면 충분히 충실하다.
const MAX_SEGMENTS = 4;

// 격려를 제외한 조각의 보존 우선순위(높을수록 먼저 살아남는다).
// 시간이 임박한 납부(행동 필요) > 추세(맥락) > 보험 점검 > 절감 제안 순.
const SEGMENT_PRIORITY: Record<CoachSegment["key"], number> = {
  praise: 100, // 항상 보존(자르기 대상 아님)
  upcoming: 4,
  trend: 3,
  insurance: 2,
  savings: 1
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

  // 2) 지난달 대비 추세 — 서버 동기화 히스토리가 있어 비교가 가능할 때만.
  //    deltaAmount 부호로 증가/감소/동일을 나눈다. 퍼센트는 있을 때만 곁들인다.
  if (input.previousMonthlyTotal !== null && input.deltaAmount !== null) {
    const delta = input.deltaAmount;
    const pct =
      input.deltaPercent !== null
        ? `${input.deltaPercent > 0 ? "+" : ""}${input.deltaPercent}%`
        : null;
    let trend: string;
    if (delta === 0) {
      trend = "이번 달 고정비는 지난달과 비슷하게 안정적으로 유지되고 있어요.";
    } else if (delta > 0) {
      const tail = pct ? `${won(delta)}(${pct}) 늘었으니` : `${won(delta)} 늘었으니`;
      trend = `이번 달 고정비가 지난달보다 ${tail} 어떤 항목이 올랐는지 한번 살펴보시면 좋겠어요.`;
    } else {
      const tail = pct ? `${won(-delta)}(${pct}) 줄였으니` : `${won(-delta)} 줄였으니`;
      trend = `이번 달 고정비를 지난달보다 ${tail} 알뜰하게 잘 관리하고 계세요.`;
    }
    segments.push({ key: "trend", example: trend });
  }

  // 3) 절감 조언 — 코드가 고른 절감 후보가 있을 때만.
  // CRITICAL: Deterministic sentence with quoted target names. No model paraphrase for meaning.
  if (input.savings.length > 0) {
    const first = input.savings[0];
    const names = first.targetItemNames && first.targetItemNames.length > 0 ? first.targetItemNames : null;
    let message: string;
    if (names && names.length === 1) {
      message = `"${names[0]}" 관련 지출의 필요 여부와 이용 조건을 확인해 보세요.`;
    } else if (names && names.length > 1) {
      const displayNames = names.slice(0, 2).map(n => `"${n}"`).join(", ");
      const countSuffix = names.length > 2 ? ` 등 ${names.length}건` : "";
      message = `${displayNames}${countSuffix} 등 검토 대상으로 남은 항목의 중복 여부를 확인해 보세요.`;
    } else {
      // Fallback: no target names provided (old caller or parse failure)
      const safeTitle = first.title.length <= 30 ? first.title : first.title.slice(0, 30);
      message = `"${safeTitle}" 관련 지출의 필요 여부와 이용 조건을 확인해 보세요.`;
    }
    segments.push({
      key: "savings",
      example: message
    });
  }

  // 4) 보험 점검 — 보험 비중이 높을 때만(휴리스틱).
  // CRITICAL: Deterministic sentence with quoted eligible names. No model paraphrase for meaning.
  // Segment targets ONLY eligible items (protected excluded, actually exists).
  // Protected names are excluded from insurance review targets at the input boundary.
  if (input.insuranceHigh) {
    const reviewNames = input.insuranceReviewItemNames;
    let message: string;
    if (reviewNames && reviewNames.length > 0) {
      const quotedNames = reviewNames.map(n => `"${n}"`).join(", ");
      message = `${quotedNames}의 보장 내용을 확인해 보면, 지출 흐름을 더 탄탄히 다질 수 있어요.`;
    } else {
      message = "보험료 비중을 살펴보고, 변경 가능한 항목이 있다면 보장 내용을 확인해 볼 수 있어요.";
    }
    segments.push({
      key: "insurance",
      example: message
    });
  }

  // 5) 임박 납부 — 14일 내 도래가 있을 때만.
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

  return capSegments(segments);
}

// 조각이 MAX_SEGMENTS 를 넘으면 우선순위가 낮은 것부터 버린다. 격려는 항상
// 남기고, 원래 등장 순서(흐름)는 그대로 유지한 채 "어떤 조각을 뺄지"만 고른다.
function capSegments(segments: CoachSegment[]): CoachSegment[] {
  if (segments.length <= MAX_SEGMENTS) {
    return segments;
  }
  // 우선순위 높은 순으로 정렬해 상위 MAX_SEGMENTS 개를 살릴 집합으로 고른 뒤,
  // 원래 배열을 그 집합으로 필터링해 등장 순서를 보존한다(안정적 결과).
  const keep = new Set(
    [...segments]
      .sort((a, b) => SEGMENT_PRIORITY[b.key] - SEGMENT_PRIORITY[a.key])
      .slice(0, MAX_SEGMENTS)
  );
  return segments.filter((s) => keep.has(s));
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
let engineReady = false; // 엔진이 로드 완료되어 재사용 가능한지 추적

export type LoadProgress = { progress: number; text: string };

/**
 * CRITICAL: 엔진 상태 확인 (초기화하지 않음)
 * - 메모리에 준비된 엔진이 있는지 확인
 * - 콜드 스타트가 필요한지 판단
 * - UI에서 동의 필요 여부 결정에 사용
 */
/** @deprecated Legacy non-UI loader. Production coaching uses pageManager's worker. */
export function getCoachEngineStatus(): "none" | "loading" | "ready" {
  if (engineReady && enginePromise) {
    return "ready";
  }
  if (enginePromise) {
    return "loading";
  }
  return "none";
}

/**
 * WebLLM 엔진을 lazy 로드한다.
 *
 * CRITICAL CONSENT POLICY:
 * - 콜드 스타트(엔진이 메모리에 없음) → 반드시 explicit consent 필요
 * - 이미 메모리에 엔진이 있음 → consent 불필요 (이미 로드됨)
 * - consent 없이 콜드 시작하면 에러 발생
 *
 * @param onProgress 진행률 콜백 (다운로드/초기화)
 * @param consent 콜드 스타트에 대한 명시적 사용자 동의 (REQUIRED for cold start)
 */
/** @deprecated Legacy loader kept for compatibility tests; do not call from UI. */
export async function getCoachEngine(
  onProgress?: (p: LoadProgress) => void,
  consent?: { explicitDownloadConsent: boolean }
): Promise<MLCEngineInterface> {
  if (!isWebGpuAvailable()) {
    throw new Error("WEBGPU_UNAVAILABLE");
  }

  // 이미 준비된 엔진이 있으면 재사용 (동의 불필요)
  if (engineReady && enginePromise) {
    return enginePromise;
  }

  // 로딩 중인 엔진이 있으면 대기 (이미 동의된 것)
  if (enginePromise) {
    return enginePromise;
  }

  // 콜드 스타트 - 명시적 동의 필수
  if (!consent?.explicitDownloadConsent) {
    throw new Error("EXPLICIT_CONSENT_REQUIRED");
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

    const engine = await CreateMLCEngine(COACH_MODEL_ID, {
      appConfig,
      initProgressCallback: (report: InitProgressReport) => {
        onProgress?.({ progress: report.progress, text: report.text });
      }
    });

    // 로드 완료 - 재사용 가능
    engineReady = true;
    return engine;
  })();

  try {
    return await enginePromise;
  } catch (error) {
    // 실패 시 다음 시도에서 재로드 가능하도록 캐시를 비운다.
    enginePromise = null;
    engineReady = false;
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
    temperature: COACH_MODEL_GENERATION.temperature,
    top_p: COACH_MODEL_GENERATION.top_p,
    frequency_penalty: COACH_MODEL_GENERATION.frequency_penalty,
    presence_penalty: COACH_MODEL_GENERATION.presence_penalty,
    // 한 문장이라 토큰 상한을 짧게 둬 군더더기를 원천 차단.
    max_tokens: COACH_MODEL_GENERATION.max_tokens,
    // CRITICAL — Qwen3.5 는 본문 앞에 <think>...</think> 블록을 끼울 수 있다.
    // SDK 의 chat completion 에는 extra_body.enable_thinking 플래그가 있어
    // false 로 두면 그 블록이 응답에 들어가지 않는다. UI 사고 차단.
    ...(COACH_MODEL_ENABLE_THINKING === false
      ? { extra_body: { enable_thinking: false } }
      : {}),
    stream: true
  });

  let raw = "";
  for await (const chunk of chunks) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      raw += delta;
      // 누적 단계에서도 think 흔적이 보이면 잘라내고 보정.
      const cleaned = clampToOneSentence(stripQwenThink(raw)) || segment.example;
      onPartial?.(cleaned);
    }
  }
  // 최종 단계에서도 같은 정리.
  const cleaned = stripQwenThink(raw);
  const result = clampToOneSentence(cleaned);
  // 잘려서 닫히지 않은 think 블록이 남아있으면 패러프레이즈 실패로 보고 원문
  // 폴백. 사고 방지.
  if (looksLikeUnfinishedThink(result)) {
    return segment.example;
  }
  // 모델 출력이 비었거나 비정상으로 짧으면(패러프레이즈 실패) 원문 폴백.
  return result.length >= 6 ? result : segment.example;
}

/**
 * 코칭을 조각별로 '순차' 생성해 코드로 결합한다. onToken 으로 누적 결과를
 * 흘려보내(한 줄씩 채우기) 순차 대기 체감을 줄인다.
 *
 * CRITICAL SAFETY DESIGN:
 * - 'praise' 조각만 모델 패러프레이즈를 거친다 (중립적 표현 다듬기).
 * - savings/insurance/trend/upcoming 은 코드에서 만든 완성 문장을 그대로 사용한다.
 *   금액·항목명·방향성·날짜 같은 사실적 정보는 모델이 바꿀 수 없다.
 * - WebLLM 은 동시 추론을 지원하지 않으므로 조각은 await 로 하나씩 처리한다.
 */
export async function streamCoaching(
  engine: MLCEngineInterface,
  input: CoachInput,
  onToken?: (full: string) => void,
  options?: { protectedItemNames?: readonly string[] }
): Promise<string> {
  const segments = selectCoachSegments(input);
  const done: string[] = [];

  for (const segment of segments) {
    // CRITICAL: actionable/factual segments are deterministic — never delegate meaning to model.
    // Only 'praise' goes through the model for neutral wording polish.
    if (segment.key !== "praise") {
      // Direct code output — no engine.create call. Guard still applies for safety.
      const guard = (text: string) => options?.protectedItemNames?.some(name => name.length > 0 && text.includes(name)) ? segment.example : text;
      const sentence = guard(segment.example);
      done.push(sentence);
      onToken?.(done.join(" "));
      continue;
    }

    // Praise: model paraphrase for neutral wording. Local output guard only.
    // Private protection metadata never enters model messages.
    const guard = (text: string) => options?.protectedItemNames?.some(name => name.length > 0 && text.includes(name)) ? segment.example : text;
    // 진행 중 조각은 done(확정분) 뒤에 실시간으로 이어 붙여 표시한다.
    const sentence = await generateSegment(engine, segment, (partial) => {
      onToken?.([...done, guard(partial)].filter(Boolean).join(" "));
    });
    if (sentence) {
      done.push(guard(sentence));
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
