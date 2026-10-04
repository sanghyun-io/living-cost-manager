// 중앙 마케팅 집계(선택 참여) — 동의·전송기록 저장소.
//
// 프라이버시 계약:
// - 기본값 OFF. 동의 저장 키가 없거나 "on"이 아니면 어떤 마케팅 요청도 나가지 않는다.
// - 동의는 이 브라우저의 localStorage에만 기록된다. 계정/사용자 식별자와 무관하고,
//   서버로 전송하는 값("event" 이름 3종)에는 전혀 관여하지 않는다.
// - navigator.globalPrivacyControl(true) 또는 DNT("1"/"true")가 켜진 브라우저에서는
//   동의를 허용하지 않고, 스토리지에 "on"이 남아있어도(예: 타이트 모드 주입) 무효화한다.
// - 저장소 오류 처리 방향은 항상 "거부": 읽기 실패 → OFF, 기록 검증 실패 → 동의
//   불허 + 롤백, 해제 시 삭제 실패 → 메모리 차단(denyInMemory). 기존 "on"/scope가
//   살아있어도 해제 시도 이후에는 전송하지 않는다.
//
// first-value dedup 의미 (의도된 설계):
// - 전송 여부는 (현재 동의 범위 id, 이벤트 이름) 조합으로 판단한다. 동의 범위는
//   동의를 켤 때마다 발급되는 랜덤 id이고 서버로 전송되지 않는다.
// - 즉 집계 단위는 **이 브라우저의 이 동의 기간**이다 — 사람 단위 집계다, 와는
//   무관하다. 다른 브라우저/기기/시크릿 저장소는 각각 새 집계이고, 동의 해제 후
//   재동의하면 같은 이벤트가 새 기간으로 세어질 수 있다. 카운트 정확도보다
//   개인정보 최소화와 중복 전송 방지(디스패치 시점 선기록)를 우선한다.
// - localStorage 키 개수는 상한: 동의 2개 + 이벤트 3종 고정 키. 별도로
//   sessionStorage에 해제 보호 키 1개만 둔다. 범위 id가 바뀌어도 키가
//   늘지 않도록 마커 키에 범위를 넣지 않고 값으로 범위를 저장한다.

/** 동의 상태 저장 키: "on"만 허용. 해제는 먼저 "off"를 기록한 뒤 삭제한다. */
export const MARKETING_CONSENT_STORAGE_KEY = "living-cost-manager:marketing-consent:v1";
/** 동의 범위 저장 키: 동의 활성화 시 발급되는 랜덤 id. 해제하면 즉시 삭제. */
export const MARKETING_CONSENT_SCOPE_STORAGE_KEY = "living-cost-manager:marketing-consent-scope:v1";
/** 전송 마커 접두어. 키 3개로 고정, 값 = 그 이벤트를 보낸 동의 범위 id. */
export const MARKETING_SENT_KEY_PREFIX = "living-cost-manager:marketing-sent:v1:";
export const MARKETING_SESSION_REVOKED_KEY = "living-cost-manager:marketing-session-revoked:v1";

export type MarketingConsent = {
  /** 명시 동의 + 스토리지 유효 + GPC/DNT 없음 + 메모리 차단 없음. */
  enabled: boolean;
  /** enabled일 때만 의미 있는 현재 동의 기간 id. */
  scope: string | null;
  /** 브라우저 수준의 GPC/DNT 감지 여부. */
  browserOptOut: boolean;
};

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// 해제 시 삭제 실패(Storage SecurityError/quota)가 있어도 이 탭에서는 즉시
// 전송을 차단하기 위한 메모리 깃발. 성공적인 enable이 이를 해제한다.
let denyInMemory = false;

function sessionRevoked(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.sessionStorage?.getItem(MARKETING_SESSION_REVOKED_KEY) === "off"; }
  catch { return true; }
}

function setSessionRevoked(revoked: boolean): boolean {
  if (typeof window === "undefined") return !revoked;
  try {
    const storage = window.sessionStorage;
    if (!storage) return !revoked;
    const value = revoked ? "off" : "on";
    storage.setItem(MARKETING_SESSION_REVOKED_KEY, value);
    return storage.getItem(MARKETING_SESSION_REVOKED_KEY) === value;
  } catch { return false; }
}

export function getMarketingStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readValue(storage: StorageLike | null, key: string): { ok: boolean; value: string | null } {
  if (!storage) return { ok: false, value: null };
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

/** 성공적인 setItem + read-back 검증까지 수행. 실패 시 false(부분 기록 인정 불가). */
function writeValue(storage: StorageLike | null, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

function removeValue(storage: StorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* 삭제 실패는 호출자의 메모리 차단으로 보완된다. */
  }
}

/** GPC + DNT(비표준 접두 변형 포함) 검사. 접근 자체가 throw 나는 브라우저 방어. */
export function isBrowserOptOut(): boolean {
  if (typeof navigator === "undefined") return false;
  try {
    const nav = navigator as Navigator & Record<string, unknown>;
    if (nav.globalPrivacyControl === true) return true;
    if (nav.doNotTrack === "1" || nav.doNotTrack === "true") return true;
    if (nav.webkitDoNotTrack === "1" || nav.webkitDoNotTrack === true) return true;
    if (nav.msDoNotTrack === "1") return true;
    if (typeof window !== "undefined" && (window as Window & { doNotTrack?: string }).doNotTrack === "1") return true;
  } catch {
    return true;
  }
  return false;
}

function generateScope(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fallthrough */
  }
  return "scope-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** 현재 동의 상태를 읽는다. 모든 저장소 오류는 OFF 방향으로 수렴한다. */
export function readMarketingConsent(): MarketingConsent {
  const browserOptOut = isBrowserOptOut();
  const storage = getMarketingStorage();
  const raw = readValue(storage, MARKETING_CONSENT_STORAGE_KEY);
  const scope = readValue(storage, MARKETING_CONSENT_SCOPE_STORAGE_KEY);
  const scopeValue = typeof scope.value === "string" && scope.value.length > 0 && scope.value.length <= 128 ? scope.value : null;
  const enabled = !browserOptOut && !denyInMemory && !sessionRevoked() && raw.ok && raw.value === "on" && scope.ok && scopeValue !== null;
  return { enabled, scope: enabled ? scopeValue : null, browserOptOut };
}

/** GPC/DNT 정리용: 브라우저 설정과 무관하게 스토리지에 동의가 기록돼 있는지. */
export function hasStoredMarketingConsent(): boolean {
  const storage = getMarketingStorage();
  return readValue(storage, MARKETING_CONSENT_STORAGE_KEY).value === "on";
}

/**
 * 동의를 켠다. GPC/DNT 브라우저에서는 거부하고 저장 상태를 정리한다.
 * 이미 켜져 있으면 현재 범위(동의 기간)를 유지한다 — 토글로 기간이 갱신되지 않는다.
 * 쓰기·read-back 검증이 하나라도 실패하면 동의하지 않은 상태로 롤백한다.
 */
export function enableMarketingConsent(): MarketingConsent {
  if (isBrowserOptOut()) {
    disableMarketingConsent();
    return readMarketingConsent();
  }
  const current = readMarketingConsent();
  if (current.enabled && current.scope) return current;
  const storage = getMarketingStorage();
  if (!storage) {
    disableMarketingConsent();
    return readMarketingConsent();
  }
  const scope = generateScope();
  // 범위→동의 순서로 기록하고 각각 검증. 중간 실패 시 두 키를 모두 삭제해
  // "on인데 범위 없음" 또는 "범위만 있는" 부분 상태를 남기지 않는다.
  if (!writeValue(storage, MARKETING_CONSENT_SCOPE_STORAGE_KEY, scope)) {
    disableMarketingConsent();
    return readMarketingConsent();
  }
  if (!writeValue(storage, MARKETING_CONSENT_STORAGE_KEY, "on") || !setSessionRevoked(false)) {
    disableMarketingConsent();
    return readMarketingConsent();
  }
  denyInMemory = false;
  return readMarketingConsent();
}

/**
 * 동의를 끈다. OFF 기록 후 삭제하며, 별도 세션/메모리 차단도 적용한다.
 * 반환값은 공유 저장소에서 해제 상태를 확인했는지다. false이면 호출자가
 * 다른 탭/새 페이지까지 영구 해제되었다고 표시하지 않고 경고해야 한다.
 */
export function disableMarketingConsent(): boolean {
  denyInMemory = true;
  // Tab-local durable fallback covers reload when shared storage cannot mutate.
  // Failure of BOTH stores cannot be made globally durable; caller must warn.
  setSessionRevoked(true);
  const storage = getMarketingStorage();
  // Write OFF before attempting deletion. removeItem may independently fail;
  // the verified tombstone still reaches other tabs and survives reloads.
  writeValue(storage, MARKETING_CONSENT_STORAGE_KEY, "off");
  removeValue(storage, MARKETING_CONSENT_SCOPE_STORAGE_KEY);
  removeValue(storage, MARKETING_CONSENT_STORAGE_KEY);
  const raw = readValue(storage, MARKETING_CONSENT_STORAGE_KEY);
  const scope = readValue(storage, MARKETING_CONSENT_SCOPE_STORAGE_KEY);
  return raw.ok && scope.ok && (raw.value !== "on" || !scope.value || scope.value.length > 128);
}

/** 이벤트 마커 키 — 3종 이벤트에 고정(개수 상한). */
export function marketingSentKey(event: string): string {
  return MARKETING_SENT_KEY_PREFIX + event;
}

/**
 * 이 동의 범위에서 이미 전송을 표시했는지. 읽기 실패는 "전송됨"으로 보수 처리한다
 * (중복 전송 방지 = 정확도보다 프라이버시).
 */
export function hasMarketingSentMarker(scope: string, event: string): boolean {
  const read = readValue(getMarketingStorage(), marketingSentKey(event));
  if (!read.ok) return true;
  return read.value === scope;
}

/**
 * 디스패치 직전 전송 표시. 스토리지에 실제로 기록(값 = 범위 id) 검증까지
 * 성공해야 true. 실패하면 호출자는 전송하지 않는다 — 기록 없는 전송은
 * 중복을 막을 수 없으므로 원천 차단한다.
 */
export function markMarketingSent(scope: string, event: string): boolean {
  return writeValue(getMarketingStorage(), marketingSentKey(event), scope);
}

/** 테스트 전용: 메모리 차단 깃발 초기화(모듈 상태 격리). */
export function __resetMarketingConsentMemoryForTests(): void {
  denyInMemory = false;
}
