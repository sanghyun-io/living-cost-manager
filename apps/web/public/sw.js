// 캐시 버전을 올리면 activate 단계에서 이전 캐시가 정리된다.
// v2: cross-origin(API) 요청을 캐싱 대상에서 제외하도록 fetch 핸들러 수정.
const cacheName = "living-cost-manager-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(cacheName).then((cache) => cache.addAll(["./", "./manifest.webmanifest", "./icon.svg"]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  // cross-origin 요청(예: api.gamja.top 의 워크스페이스/스냅샷 GET)은 캐싱하지
  // 않는다. 캐싱하면 다른 기기에서 동기화한 최신 데이터 대신 오래된 응답이
  // 돌아와 낙관적 잠금(syncVersion)과도 어긋난다. 앱 셸(same-origin)만 캐싱한다.
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return; // 브라우저 기본 네트워크 처리에 맡긴다.
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(cacheName).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((response) => response || caches.match("./")))
  );
});

// Web Push 수신 → 알림 표시. payload 는 {title, body, url} JSON.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "생활비 고정비 관리자";
  const options = {
    body: data.body || "",
    icon: "./icon.svg",
    badge: "./icon.svg",
    data: { url: data.url || "./" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 알림 클릭 → 해당 URL(또는 앱)로 포커스/이동.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client && targetUrl !== "./") {
            client.navigate(targetUrl);
          }
          return undefined;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
