// 온디바이스 LLM 코치 — 모델 설정 + opt-in 상태.
//
// 런타임: WebLLM(MLC) + WebGPU. 모델은 사용자 브라우저에서 직접 추론하므로
// 추론은 기기에서 실행되며 지출 정보를 외부 AI 분석 API로 보내지 않는다.
// Cache API/IndexedDB 에 저장되며, 브라우저 캐시 정책에 따라 삭제될 수 있다.
//
// 모델: Qwen3.5-0.8B (q4f16_1) — WebLLM prebuilt 0.2.84. Qwen 계열이라 한국어가 양호하다.
// VRAM 필요량: 약 1629.49MB (SDK modelVersion v0_2_84/base 의 prebuilt 레코드 기준)
// 다운로드 크기: 약 453MB (안내용)
// 컨텍스트 윈도우: 4096 (prebuilt overrides 에 의해 강제됨)
//
// CRITICAL — prebuiltAppConfig 의 overrides:
//   {
//     vram_required_MB: 1629.49,
//     low_resource_required: true,
//     overrides: { context_window_size: 4096, max_history_size: 1 }
//   }
// `max_history_size: 1` 는 KV 캐시가 누적되지 않게 강제하므로 chat history 를
// 페이지에서 보내더라도 한 번의 추론 단위로 컨텍스트가 정리된다. 본 프로젝트는
// 어차피 격려 패러프레이즈 한 문장만 요청하므로 충돌 없다.

// WebLLM prebuilt 모델 ID. prebuildAppConfig 에 포함돼 있어 model_lib(.wasm)은
// MLC CDN 에서 자동 로드된다.
export const COACH_MODEL_ID = "Qwen3.5-0.8B-q4f16_1-MLC";

// CRITICAL — Qwen3.5 는 본문 앞에 <think>...</think> 블록을 자주 끼워 보낸다.
// 저장 시 enable_thinking=false 를 SDK 에 전달해 그 블록이 UI 까지 올라오지 않게
// 한다 (한 문장 패러프레이즈 작업에는 사고가 된다).
export const COACH_MODEL_ENABLE_THINKING: boolean = false;

// 격려 조각에 적용하는 generation 파라미터.
// 패러프레이즈 작업이라 temp 를 낮춰 원문에 바싹 붙이고, max_tokens 를 짧게
// 둬 군더더기/<think> 블록 누출을 원천 차단한다.
//
// CRITICAL — SDK 의 ChatCompletionRequest.extra_body.enable_thinking 플래그가
// 활성화되면 chat 요청에 함께 흘려보내야 본문에서 <think> 블록이 제거된다.
export const COACH_MODEL_GENERATION = {
  temperature: 0.2,
  top_p: 0.9,
  frequency_penalty: 0.4,
  presence_penalty: 0.2,
  max_tokens: 70
} as const;

// 모델 가중치를 우리 R2 버킷에서 서빙할 때의 베이스 URL.
// 설정되면 WebLLM appConfig 의 해당 모델 `model` 필드를 이 URL 로 덮어쓴다.
// 미설정(빈 문자열)이면 WebLLM 기본 CDN(HuggingFace)을 사용한다.
// 예: https://models.gamja.top/qwen3.5-0.8b-q4f16_1-MLC/
//
// Unset is the source-code default, not a claim about deployment settings.
// Reject stale URLs for a different model. The worker UI uses the SDK default.
export function getCoachModelBaseUrl(
  value = process.env.NEXT_PUBLIC_COACH_MODEL_BASE_URL
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  // 모델-특정 검증: override URL 이 모델 ID 와 일치하는 경로 세그먼트를
  // 포함하지 않으면(예: 옛 qwen2.5 베이스 URL 이 들어오는 사고) null 을
  // 반환해 default CDN 으로 폴백한다. override 는 "models.gamja.top/<modelId>/"
  // 경로 컨벤션을 따른다는 전제.
  if (!trimmed.includes(COACH_MODEL_ID)) {
    return null;
  }
  return trimmed.replace(/\/+$/, "") + "/";
}

// 사용자가 한 번 받아야 하는 대략적인 다운로드 크기(안내 문구용).
// prebuilt 가이드 기준 ~453MB.
export const COACH_MODEL_APPROX_MB = 453;

// 모델 로드에 필요한 GPU VRAM (MB) - SDK modelVersion 의 prebuilt 레코드 기준.
export const COACH_MODEL_VRAM_MB = 1629.49;

// ── 기능 opt-in 상태 (localStorage) ─────────────────────────────────────────
// 코치 기능 활성화 여부. 사용자가 기능을 켰는지 기억한다.
// 이것은 기능 선호도일 뿐, 다운로드 동의를 의미하지 않는다.
const COACH_OPT_IN_KEY = "living-cost-manager:coach-opt-in:v1";

export function isCoachOptedIn(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(COACH_OPT_IN_KEY) === "1";
}

export function setCoachOptIn(value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  if (value) {
    window.localStorage.setItem(COACH_OPT_IN_KEY, "1");
  } else {
    window.localStorage.removeItem(COACH_OPT_IN_KEY);
  }
}

// WebGPU 지원 여부(코치 가용성의 전제). 미지원이면 규칙 기반 폴백을 보여준다.
export function isWebGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

// ── 중요: 다운로드 동의는 attempt-scoped (시도별) ────────────────────────────
//
// CRITICAL: 모델 다운로드는 반드시 사용자의 명시적 동의가 필요하다.
// 이 동의는 localStorage에 영구 저장되지 않으며, 각 시도마다 새로 얻어야 한다.
//
// 동의 원칙:
// 1. 콜드 스타트(엔진이 메모리에 없음) → 반드시 동의 필요
// 2. 이미 메모리에 엔진이 있음 → 동의 불필요 (이미 로드됨)
// 3. 캐시 확인만으로는 동의를 대체할 수 없음 (캐시는 불완전하거나 evict될 수 있음)
//
// 구현 참고:
// - useCoach.ts의 coachAttemptConsent 상태로 관리
// - 모달이 닫히면 동의는 무효화됨
// - getCoachEngine 호출 전 반드시 동의 확인
