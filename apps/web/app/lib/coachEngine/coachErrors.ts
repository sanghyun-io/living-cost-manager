// 코치 오류 → 사용자 노출용 고정 한국어 메시지 매핑.
//
// 보안 정책 (security review 이후 도입):
// - SDK/워커의 원시 error.message 는 모델 URL·서명 쿼리·스택·프롬프트 조각 등
//   내부 진단 정보를 포함할 수 있다. 원시 문자열은 "분류 판정"에만 사용하고
//   절대 UI·store 스냅샷·로그로 흘리지 않는다.
// - 사용자에게는 아래 COACH_USER_ERRORS 의 고정 문자열 중 하나만 노출된다.
// - 취소(cancel)는 상태 머신이 별도 처리하므로(error 가 null, cancelled 상태)
//   이 매핑의 대상이 아니다.
// - 분류 실패(unknown)에도 고정 한국어 폴백을 반환한다. 원시 텍스트는 어디에도
//   보존하지 않는다(진단용 출력은 유한 enum kind 뿐).
//
// 이 모듈은 메인 스레드 컨트롤러(store/useCoach)에서만 import 한다. 워커
// (app/Worker/coachWorker.ts)와 워커 프로토콜은 변경하지 않는다.

export type CoachErrorPhase = "prepare" | "inference";

// 진단용 유한 enum. 원시 메시지·URL·스택을 보존하지 않는다.
export type CoachErrorKind =
  | "consent-required"
  | "device-lost"
  | "out-of-memory"
  | "gpu-unsupported"
  | "network"
  | "chat"
  | "unknown";

// 사용자 화면에 나올 수 있는 문자열의 전부. 이 집합 밖의 값은 노출되지 않는다.
export const COACH_USER_ERRORS = {
  consentRequired: "모델 다운로드에 동의가 필요합니다.",
  gpuUnsupported: "이 기기에서는 AI를 사용할 수 없어요.",
  memoryOrDisconnected: "기기 메모리가 부족하거나 AI 연결이 끊겼어요. 다른 앱을 닫고 다시 준비해 주세요.",
  prepareNetwork: "AI 준비를 마치지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.",
  prepareUnknown: "AI 준비를 마치지 못했어요. 잠시 후 다시 시도해 주세요.",
  coachingFailed: "코칭을 만들지 못했어요. 다시 시도해 주세요."
} as const;

const SAFE_MESSAGE_SET: ReadonlySet<string> = new Set(Object.values(COACH_USER_ERRORS));

// main 스레드 가드 코드(store.beginPreparation, ENGINE_NOT_READY 등)는 유한
// 집합이므로 정규식 분류 전에 정확 일치로 처리한다. 이 코드 자체는 민감 정보가
// 아니지만 화면에 그대로 노출하지 않고 고정 메시지로 변환한다.
const INTERNAL_CODE_KINDS: Readonly<Record<string, CoachErrorKind>> = {
  EXPLICIT_CONSENT_REQUIRED: "consent-required",
  WEBGPU_UNAVAILABLE: "gpu-unsupported",
  MODEL_GRANT_MISMATCH: "unknown",
  ENGINE_NOT_READY: "chat"
};

// 순서가 분류 우선순위다: 연결 끊김/메모리 → GPU 미지원 → 네트워크.
// (예: "GPU 연결이 끊겼습니다"는 gpu-unsupported 가 아니라 device-lost 여야 한다.)
// 패턴은 원시 메시지를 판정만 하고 결과에는 아무 조각도 남기지 않는다.
const KIND_PATTERNS: ReadonlyArray<readonly [CoachErrorKind, RegExp]> = [
  ["device-lost", /device\s+(?:was\s+|is\s+)?lost|lost\s+(?:the\s+)?(?:gpu|webgpu|device|context)|context\s+lost|gpu\s*연결|연결이\s*끊|워커|worker/i],
  ["out-of-memory", /out of memory|\boom\b|insufficient memory|not enough memory|memory (?:allocation|limit|error)|메모리/i],
  ["gpu-unsupported", /webgpu (?:is |'s )?not (?:available|supported)|webgpu.{0,12}(?:unavailable|unsupported|not available)|no (?:available |valid )?(?:gpu|webgpu|adapter)|gpu (?:is )?not available|unsupported gpu|gpu unsupported|adapter (?:is null|not (?:found|available|supported)|failed|creation failed)|requestadapter/i],
  ["network", /failed to fetch|fetch failed|network|err_[a-z0-9_]+|offline|timed[ _-]?out|timeout|download|econn|enotfound|dns|proxy|unreachable|could not load/i]
];

// cancelled 는 상태 머신이 소유한다(cancelPreparation → state "cancelled", error null).
// 추론 중 사용자 중단(AbortError 등)은 세대가 바뀐 시점의 catch early-return 으로
// 이미 UI 에 도달하지 않으며, 혹시 남는 abort성 원시 메시지는 추론 폴백 메시지로
// 수렴한다. 별도 kind 분리나 원시 렌더는 하지 않는다.

export function classifyCoachError(rawMessage: string): CoachErrorKind {
  const trimmed = rawMessage.trim();
  if (!trimmed) return "unknown";
  const codeKind = INTERNAL_CODE_KINDS[trimmed];
  if (codeKind) return codeKind;
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(trimmed)) return kind;
  }
  return "unknown";
}

export function coachUserMessageFor(kind: CoachErrorKind, phase: CoachErrorPhase): string {
  switch (kind) {
    case "consent-required":
      return COACH_USER_ERRORS.consentRequired;
    case "gpu-unsupported":
      return COACH_USER_ERRORS.gpuUnsupported;
    case "device-lost":
    case "out-of-memory":
      return COACH_USER_ERRORS.memoryOrDisconnected;
    case "network":
      // 준비 중 다운로드/연결 실패만 연결 안내. 추론 중에는 기기 내부 작업이라
      // '코칭 실패' 안내가 맞다.
      return phase === "prepare" ? COACH_USER_ERRORS.prepareNetwork : COACH_USER_ERRORS.coachingFailed;
    case "chat":
    case "unknown":
    default:
      return phase === "prepare" ? COACH_USER_ERRORS.prepareUnknown : COACH_USER_ERRORS.coachingFailed;
  }
}

/**
 * 원시 오류(Error.message 또는 문자열)를 받아 사용자 고정 한국어 메시지 하나로
 * 변환한다. 반환값은 반드시 COACH_USER_ERRORS 의 값 중 하나이며, 입력의 어떤
 * 부분(URL·스택·프롬프트·서명 쿼리)도 포함하지 않는다.
 *
 * 주의: 이미 변환된 고정 문자열을 다시 이 함수에 넣으면 분류가 달라질 수 있다
 * (멱등 아님). 변환은 원시 오류가 시스템에 유입되는 경계(store 전이, 직접 catch)
 * 에서 1회만 수행하고, 이후 경로에서는 변환된 값을 그대로/display 한다.
 */
export function sanitizeCoachError(raw: unknown, phase: CoachErrorPhase): string {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  const message = coachUserMessageFor(classifyCoachError(text), phase);
  // 방어진: 이 함수의 출력은 유한 집합 밖일 수 없다.
  return SAFE_MESSAGE_SET.has(message) ? message : phase === "prepare" ? COACH_USER_ERRORS.prepareUnknown : COACH_USER_ERRORS.coachingFailed;
}
