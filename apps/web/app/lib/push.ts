// Web Push 구독 클라이언트. 서버의 /push/* 엔드포인트와 통신하고 브라우저
// PushManager 를 다룬다. serverApi(대형 인터페이스)와 분리해 자체 완결로 둔다.

export type PushConfig = { enabled: boolean; publicKey: string | null };

// VAPID 공개키(base64url)를 PushManager.subscribe 가 요구하는 Uint8Array 로.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export async function getPushConfig(baseUrl: string): Promise<PushConfig> {
  const res = await fetch(`${baseUrl}/push/public-key`, { method: "GET" });
  if (!res.ok) {
    return { enabled: false, publicKey: null };
  }
  return (await res.json()) as PushConfig;
}

/** 브라우저가 Web Push 를 지원하는지(서비스워커 + PushManager + Notification). */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export type SubscribeResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "no-config" | "error" };

/**
 * 알림 권한을 요청하고 푸시를 구독한 뒤 서버에 등록한다.
 * 이미 등록된 서비스워커(./sw.js)를 사용한다.
 */
export async function subscribeToPush(baseUrl: string, token: string): Promise<SubscribeResult> {
  if (!isPushSupported()) {
    return { ok: false, reason: "unsupported" };
  }
  const config = await getPushConfig(baseUrl);
  if (!config.enabled || !config.publicKey) {
    return { ok: false, reason: "no-config" };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "denied" };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const applicationServerKey = urlBase64ToUint8Array(config.publicKey);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // BufferSource 로 명시 캐스팅(Uint8Array<ArrayBufferLike> 호환 위해).
      applicationServerKey: applicationServerKey as BufferSource
    });

    const json = subscription.toJSON();
    const res = await fetch(`${baseUrl}/push/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth }
      })
    });
    if (!res.ok) {
      return { ok: false, reason: "error" };
    }
    return { ok: true };
  } catch (_e) {
    return { ok: false, reason: "error" };
  }
}

/** 현재 브라우저 구독을 해지하고 서버에서도 제거한다. */
export async function unsubscribeFromPush(baseUrl: string, token: string): Promise<boolean> {
  if (!isPushSupported()) {
    return false;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      return true;
    }
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await fetch(`${baseUrl}/push/subscriptions`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint })
    });
    return true;
  } catch (_e) {
    return false;
  }
}
