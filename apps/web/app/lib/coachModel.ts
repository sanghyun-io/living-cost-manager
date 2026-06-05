// 온디바이스 LLM 코치 — 모델 설정 + opt-in 상태.
//
// 런타임: WebLLM(MLC) + WebGPU. 모델은 사용자 브라우저에서 직접 추론하므로
// 서빙 비용·외부 API 호출이 없다(완전 무료·오프라인·프라이버시). 가중치는
// 최초 1회만 내려받아 Cache API/IndexedDB 에 영구 저장된다.
//
// 모델: Qwen2.5-0.5B-Instruct (q4f16) — WebLLM prebuilt. Qwen 계열이라 한국어가
// 양호하고, ~0.5GB 라 iOS origin 캐시 한도(~1GB)도 통과한다.

// WebLLM prebuilt 모델 ID. prebuildAppConfig 에 포함돼 있어 model_lib(.wasm)은
// MLC CDN 에서 자동 로드된다.
export const COACH_MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

// 모델 가중치를 우리 R2 버킷에서 서빙할 때의 베이스 URL.
// 설정되면 WebLLM appConfig 의 해당 모델 `model` 필드를 이 URL 로 덮어쓴다.
// 미설정(빈 문자열)이면 WebLLM 기본 CDN(HuggingFace)을 사용한다.
// 예: https://models.gamja.top/qwen2.5-0.5b-instruct-q4f16_1-MLC/
export function getCoachModelBaseUrl(
  value = process.env.NEXT_PUBLIC_COACH_MODEL_BASE_URL
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "") + "/";
}

// 사용자가 한 번 받아야 하는 대략적인 다운로드 크기(안내 문구용).
export const COACH_MODEL_APPROX_MB = 500;

// ── opt-in 상태 (localStorage) ──────────────────────────────────────────────
// 코치는 명시적 opt-in 기능이다. 큰 1회 다운로드가 따르므로 사용자가 직접 켠다.
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
