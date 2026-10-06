// Browser privacy regression. All mutation requests are intercepted, including on
// public targets: this harness NEVER writes marketing totals or application data.
// node scripts/verify-marketing.mjs --url http://127.0.0.1:3317
// node scripts/verify-marketing.mjs --public-safe --url https://example.test
// node scripts/verify-marketing.mjs --serve apps/web/out
// Add --scenario storage-revoke-remove for the focused revocation gate.
// node scripts/verify-marketing.mjs --self-test
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

const events = ["personal_cost_saved", "personal_billing_date_saved", "personal_renewal_decision_saved"];
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
// If production pins a versioned script, coordinator supplies the exact observed
// URL (not an origin wildcard). It is still aborted before any network delivery.
const knownCloudflareScript = process.env.LCM_E2E_KNOWN_CF_SCRIPT_URL || "https://static.cloudflareinsights.com/beacon.min.js";
function validateKnownCloudflareScript(value) {
  const url = new URL(value);
  assert.equal(url.origin, "https://static.cloudflareinsights.com");
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  assert.match(url.pathname, /^\/beacon\.min\.js(?:\/v[a-f0-9]{32,64})?$/);
  return url.href;
}
validateKnownCloudflareScript(knownCloudflareScript);
function isStaticAsset(url, resourceType) {
  return !url.search && !/privacy-|98765/.test(url.pathname) &&
    ["script", "stylesheet", "image", "font", "manifest"].includes(resourceType) &&
    (/^\/_next\/static\//.test(url.pathname) || ["/icon.svg", "/manifest.webmanifest", "/favicon.ico"].includes(url.pathname));
}
function validateTarget(value, publicSafe) {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol), "HTTP(S) target required");
  assert.ok(!url.username && !url.password && !url.search && !url.hash, "target must not contain credentials/query/fragment");
  assert.ok(publicSafe || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "public targets require --public-safe");
  return url;
}
function validatePayload(body) {
  const value = JSON.parse(body);
  assert.ok(value && !Array.isArray(value) && typeof value === "object");
  assert.deepEqual(Object.keys(value), ["event"], "only event allowed in payload");
  assert.ok(events.includes(value.event), "bounded enum required");
  return value.event;
}
function selfTest() {
  for (const event of events) assert.equal(validatePayload(JSON.stringify({ event })), event);
  for (const body of ["null", "[]", "{}", "broken", '{"event":"unknown"}', '{"event":"personal_cost_saved","amount":1}', '{"event":"personal_cost_saved","id":"private"}']) {
    assert.throws(() => validatePayload(body));
  }
  assert.equal(validateTarget("http://127.0.0.1:4321", false).port, "4321");
  assert.doesNotThrow(() => validateTarget("https://example.test", true));
  assert.doesNotThrow(() => validateKnownCloudflareScript("https://static.cloudflareinsights.com/beacon.min.js"));
  for (const value of ["https://static.cloudflareinsights.com/collect", "https://evil.test/beacon.min.js", "https://static.cloudflareinsights.com/beacon.min.js?tracking=1"]) {
    assert.throws(() => validateKnownCloudflareScript(value));
  }
  assert.equal(isStaticAsset(new URL("https://example.test/_next/static/chunk.js"), "script"), true);
  assert.equal(isStaticAsset(new URL("https://example.test/icon.svg"), "image"), true);
  for (const pathname of ["/tracking.png", "/collect.js", "/icon.svg?secret=1", "/_next/static/privacy-name-canary.js"]) {
    assert.equal(isStaticAsset(new URL(pathname, "https://example.test"), "image"), false);
  }
  for (const value of ["https://example.test", "file:///etc/passwd", "http://user:pass@localhost", "http://localhost/?private=1", "http://localhost/#private"]) {
    assert.throws(() => validateTarget(value, false));
  }
  console.log("PASS: harness unit/edge/error checks (strict schema and target safety)");
}

selfTest();
if (!args.includes("--self-test")) await main();

async function main() {
  let server, browser;
  try {
    let target = option("--url") || process.env.LCM_E2E_ORIGIN;
    if (args.includes("--serve")) {
      assert.ok(!target, "choose --serve OR --url/LCM_E2E_ORIGIN");
      const root = path.resolve(option("--serve"));
      server = createServer(async (req, res) => {
        try {
          assert.equal(req.method, "GET");
          let file = path.resolve(root, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
          assert.ok(file === root || file.startsWith(root + path.sep));
          if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
          const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
          res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
          res.end(await readFile(file));
        } catch { res.writeHead(404); res.end(); }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      target = `http://127.0.0.1:${server.address().port}`;
    }
    assert.ok(target, "provide --url, LCM_E2E_ORIGIN, or --serve");
    const url = validateTarget(target, args.includes("--public-safe"));
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    const scenarios = ["consent", "network-error", "server-error", "disable-unsent", "gpc", "dnt",
      "storage-read", "storage-consent-write", "storage-marker-write", "storage-revoke-remove", "failed-personal-save", "cross-tab", "inflight-abort"];
    const focused = option("--scenario");
    if (args.includes("--scenario")) assert.ok(scenarios.includes(focused), "--scenario requires a known scenario name");
    for (const scenario of focused ? [focused] : scenarios) {
      await runScenario(browser, url, scenario, args.includes("--public-safe"));
      console.log(`PASS: marketing browser ${scenario}`);
    }
    console.log("PASS: all marketing POSTs intercepted; no API writes, accounts, or persistent browser profiles");
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

async function runScenario(browser, target, scenario, publicSafe) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const posts = [], unexpected = [], errors = [];
  const knownExternalBlocked = [];
  const heldRoutes = [];
  try {
    // Independent observer: catch a transport missed by a route handler as a failure.
    context.on("request", request => {
      const url = new URL(request.url());
      if (!request.isNavigationRequest() && /privacy-.*canary|98765/.test(request.url() + (request.postData() || ""))) {
        unexpected.push("personal/campaign canary observed in transport");
      }
      if (!["GET", "OPTIONS"].includes(request.method()) && !url.pathname.endsWith("/marketing/events")) {
        unexpected.push("unrecognized mutation observed");
      }
    });
    // WebSockets are not covered by HTTP routing. Never connect a routed socket.
    await context.routeWebSocket("**/*", socket => {
      unexpected.push("WebSocket transport attempted");
      socket.close();
    });
    await context.exposeBinding("__privacyBlockedBeacon", () => {
      unexpected.push("sendBeacon transport attempted");
    });
    await context.addInitScript(({ scenario }) => {
      window.__privacyFault = "";
      window.__privacyFaultHits = 0;
      for (const method of ["getItem", "setItem", "removeItem"]) {
        const native = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...rest) {
          const fault = window.__privacyFault;
          const marketing = String(key).startsWith("living-cost-manager:marketing-");
          const fail = (fault === "storage-read" && marketing && method === "getItem") ||
            (fault === "storage-consent-write" && String(key).includes("marketing-consent") && method === "setItem") ||
            (fault === "storage-marker-write" && String(key).includes("marketing-sent") && method === "setItem") ||
            (fault === "storage-revoke-remove" && marketing && method === "removeItem") ||
            (fault === "failed-personal-save" && String(key).startsWith("living-cost-manager:user:") && method === "setItem");
          if (fail) { window.__privacyFaultHits++; throw new DOMException("Synthetic privacy storage failure", "QuotaExceededError"); }
          return native.call(this, key, ...rest);
        };
      }
      // Block before native invocation, including pagehide/unload delivery.
      navigator.sendBeacon = function () {
        void window.__privacyBlockedBeacon();
        return false;
      };
      if (scenario === "gpc") Object.defineProperty(navigator, "globalPrivacyControl", { get: () => true });
      if (scenario === "dnt") Object.defineProperty(navigator, "doNotTrack", { get: () => "1" });
      window.__marketingFetches = [];
      const original = window.fetch;
      window.fetch = function (input, init) {
        const request = new Request(input instanceof Request ? input.clone() : input, init);
        if (new URL(request.url).pathname.endsWith("/marketing/events")) {
          const record = {
          url: request.url, credentials: request.credentials, referrer: request.referrer,
          referrerPolicy: request.referrerPolicy, method: request.method, headers: [...request.headers.keys()],
          aborted: request.signal.aborted,
          };
          request.signal.addEventListener("abort", () => { record.aborted = true; }, { once: true });
          window.__marketingFetches.push(record);
        }
        return original.call(this, input, init);
      };
    }, { scenario });
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      // Only the deliberately synthetic landing URL may contain our canary.
      // Assets inherit that Referer by default: strip it solely on static GETs,
      // never on marketing requests (whose actual privacy headers are asserted).
      const headers = await request.allHeaders();
      const canaryHeaders = { ...headers };
      if (isStaticAsset(url, request.resourceType())) delete canaryHeaders.referer;
      if ((!request.isNavigationRequest() && /privacy-.*canary|98765/.test(request.url() + (request.postData() || ""))) ||
        /privacy-.*canary|98765/.test(JSON.stringify(canaryHeaders))) {
        unexpected.push("canary-bearing transport blocked");
        return route.abort();
      }
      // Known pre-existing infrastructure, NOT governed by first-party consent.
      // Public-only exception to failure reporting, never an egress allowance:
      // exact script URL, no query/credentials, no analytics endpoints/wildcards.
      if (publicSafe && !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) &&
        request.method() === "GET" && request.resourceType() === "script" &&
        url.href === knownCloudflareScript) {
        knownExternalBlocked.push(url.href);
        return route.abort();
      }
      if (url.pathname.endsWith("/marketing/events")) {
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
          "access-control-allow-origin": target.origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type",
        } });
        posts.push({ url: request.url(), method: request.method(), body: request.postData(), headers: await request.allHeaders() });
        if (scenario === "inflight-abort") { heldRoutes.push(route); return; }
        if (scenario === "network-error") return route.abort("failed");
        return route.fulfill({ status: scenario === "server-error" ? 503 : 202,
          contentType: "application/json", body: JSON.stringify(scenario === "server-error" ? { ok: false } : { ok: true }),
          headers: { "access-control-allow-origin": target.origin } });
      }
      // Never permit a mutation, API fetch, beacon, or third-party request to escape.
      const initialDocument = request.isNavigationRequest() && url.pathname === target.pathname &&
        (url.search === "?utm_campaign=privacy-query-canary" || url.search === "");
      const staticAsset = isStaticAsset(url, request.resourceType());
      if (request.method() !== "GET" || url.origin !== target.origin || !(initialDocument || staticAsset)) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      if (staticAsset) {
        delete headers.referer;
        return route.continue({ headers });
      }
      return route.continue();
    });
    const page = await context.newPage();
    await page.clock.install();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    const landing = new URL(target);
    landing.searchParams.set("utm_campaign", "privacy-query-canary");
    await page.goto(landing.href);
    await page.getByText("아직 등록된 고정비가 없어요", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("marketing-consent").count(), 0, "consent is not in the header or a forced popup");
    const openSettings = async targetPage => {
      if (await targetPage.getByRole("dialog").count() === 0) {
        await targetPage.getByRole("button", { name: "데이터 관리", exact: true }).first().click();
      }
      await targetPage.clock.runFor(300);
      await targetPage.getByTestId("marketing-consent").waitFor();
    };
    const closeSettings = async targetPage => {
      await targetPage.getByRole("button", { name: "데이터 관리 닫기", exact: true }).click();
      await targetPage.clock.runFor(300);
      await targetPage.getByRole("dialog").waitFor({ state: "hidden" });
    };
    // Exercise the real settings control, closing it before editing the budget.
    const consentControl = targetPage => Object.fromEntries(["waitFor", "isChecked", "isEnabled", "check", "uncheck", "click"].map(method => [method, async () => {
      await openSettings(targetPage);
      const result = await targetPage.getByTestId("marketing-consent")[method]();
      await closeSettings(targetPage);
      return result;
    }]));
    const waitForConsent = async (targetPage, enabled) => {
      await openSettings(targetPage);
      await targetPage.waitForFunction(expected => document.querySelector('[data-testid="marketing-consent"]')?.checked === expected, enabled);
      await closeSettings(targetPage);
    };
    const consent = consentControl(page);
    await consent.waitFor();
    assert.equal(await consent.isChecked(), false, "fresh context must default off");
    if (scenario === "consent") {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await page.evaluate(() => {
          const outer = document.querySelector(".app-header-shell").getBoundingClientRect();
          const inner = document.querySelector(".app-header").getBoundingClientRect();
          const main = document.querySelector("main.page-shell").getBoundingClientRect();
          return { left: outer.left, width: outer.width, viewport: innerWidth,
            innerLeft: inner.left, mainLeft: main.left, innerWidth: inner.width, mainWidth: main.width,
            border: getComputedStyle(document.querySelector(".app-header-shell")).borderBottomWidth,
            overflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.equal(geometry.left, 0); assert.equal(geometry.width, geometry.viewport);
        assert.equal(geometry.innerLeft, geometry.mainLeft); assert.equal(geometry.innerWidth, geometry.mainWidth);
        assert.equal(geometry.border, "1px"); assert.equal(geometry.overflow, false);
        assert.equal(await page.getByRole("banner").getByRole("checkbox").count(), 0);
        const screenshots = option("--screenshots");
        if (screenshots) {
          await mkdir(screenshots, { recursive: true });
          await page.screenshot({ path: path.join(screenshots, `header-${width}.png`), animations: "disabled" });
        }
        const trigger = page.getByRole("button", { name: "데이터 관리", exact: true }).first();
        await trigger.focus(); await page.keyboard.press("Enter"); await page.clock.runFor(300);
        const setting = page.getByRole("checkbox", { name: "서비스 개선을 위한 사용 통계 제공(선택)", exact: true });
        await setting.waitFor(); await setting.focus();
        assert.equal(await setting.evaluate(el => document.activeElement === el), true);
        assert.ok((await page.getByRole("dialog").innerText()).includes("과거 기록이나 아래의 개인 기기 통계를 업로드하지 않습니다"));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `settings-${width}.png`), animations: "disabled" });
        await page.keyboard.press("Escape"); await page.clock.runFor(300);
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        assert.equal(await trigger.evaluate(el => document.activeElement === el), true, "closing restores keyboard focus");
        console.log(`PASS settings ${width}px: full-width header, aligned inner content, no overflow, keyboard discovery and restored focus`);
      }
    }
    // Advance timers, rather than a 650ms wall-clock guess. Covers debounce and
    // delayed dispatch/retry up to a bounded 10s horizon after each real action.
    const settle = async (targetPage = page) => {
      await targetPage.clock.runFor(10000);
      await targetPage.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));
    };
    async function waitForPostCount(expected) {
      const deadline = Date.now() + 5000;
      while (posts.length < expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(posts.length, expected, "actual intercepted POST count");
    }
    const count = async (targetPage = page) => targetPage.evaluate(() => {
      const id = localStorage.getItem("living-cost-manager:active-user:v1");
      return JSON.parse(localStorage.getItem("living-cost-manager:user:" + encodeURIComponent(id) + ":v1"))?.fixedCosts.length || 0;
    });
    async function add(name, targetPage = page) {
      const before = await count(targetPage);
      await targetPage.getByLabel("빠른 추가", { exact: true }).fill(`${name} 98765원 매월`);
      await targetPage.getByRole("button", { name: "추가", exact: true }).click();
      await targetPage.waitForFunction(expected => {
        const id = localStorage.getItem("living-cost-manager:active-user:v1");
        return JSON.parse(localStorage.getItem("living-cost-manager:user:" + encodeURIComponent(id) + ":v1"))?.fixedCosts.length === expected;
      }, before + 1);
      await settle(targetPage);
    }
    async function editBilling(date) {
      const field = page.getByLabel(/기준 납부일/).first();
      await field.fill(date);
      assert.equal(await field.inputValue(), date);
      await persisted("billingAnchorDate", date);
      await settle();
    }
    async function editRenewal(label, status) {
      const field = page.getByRole("textbox", { name: "갱신 검토", exact: true }).first();
      await field.click();
      await page.getByRole("option", { name: label, exact: true }).click();
      assert.equal(await field.inputValue(), label);
      await persisted("renewalStatus", status);
      await settle();
    }
    async function persisted(field, value) {
      await page.waitForFunction(({ field, value }) => {
        const id = localStorage.getItem("living-cost-manager:active-user:v1");
        const data = JSON.parse(localStorage.getItem("living-cost-manager:user:" + encodeURIComponent(id) + ":v1"));
        return data?.fixedCosts.some(cost => cost[field] === value);
      }, { field, value });
    }
    await add("privacy-defaultoff-canary");
    if (scenario === "consent") {
      // Local analytics remain independent of central consent (5s batch flush).
      await page.waitForFunction(async () => {
        if (!(await indexedDB.databases()).some(db => db.name === "lcm-analytics")) return false;
        return new Promise(resolve => {
          const open = indexedDB.open("lcm-analytics");
          open.onerror = () => resolve(false);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains("events")) { db.close(); resolve(false); return; }
            const request = db.transaction("events").objectStore("events").count();
            request.onsuccess = () => { db.close(); resolve(request.result > 0); };
            request.onerror = () => { db.close(); resolve(false); };
          };
        });
      }, undefined, { timeout: 12000 });
    }
    assert.equal(posts.length, 0, "default-off personal save must not send");
    if (["gpc", "dnt"].includes(scenario)) {
      if (await consent.isEnabled()) await consent.check();
      await add("privacy-signal-canary");
      await page.evaluate(() => {
        localStorage.setItem("living-cost-manager:marketing-consent:v1", "on");
        localStorage.setItem("living-cost-manager:marketing-consent-scope:v1", "synthetic-prior-consent");
      });
      await page.reload(); await consent.waitFor(); await settle();
      await add("privacy-restored-signal-canary");
      assert.equal(posts.length, 0, `${scenario} overrides consent including reload`);
    } else if (scenario === "storage-revoke-remove") {
      await consent.check();
      const other = await context.newPage();
      other.setDefaultTimeout(10000);
      other.on("pageerror", error => errors.push(error.message));
      await other.clock.install();
      try {
        await other.goto(landing.href);
        const otherConsent = consentControl(other);
        await waitForConsent(other, true);
        assert.equal(await consent.isChecked(), true, "revoking tab initially consented");
        assert.equal(await otherConsent.isChecked(), true, "second tab initially consented");
        assert.equal(posts.length, 0, "no existing sends/dedup can mask revocation");
        await page.evaluate(() => { window.__privacyFault = "storage-revoke-remove"; });
        await consent.uncheck();
        await page.waitForFunction(() => window.__privacyFaultHits > 0);
        assert.equal(await consent.isChecked(), false, "revoking tab shows OFF despite removeItem failure");
        // Real storage propagation must notify an already-consented document.
        await waitForConsent(other, false);
        assert.equal(await otherConsent.isChecked(), false, "other tab observes persisted OFF fallback");
        await add("privacy-remove-failed-other-canary", other);
        assert.equal(posts.length, 0, "other tab fresh save blocked after failed-remove revocation");
        // Reload before mutating in the first tab: budget records need not be
        // live-synchronized between tabs, unlike the consent storage event.
        await page.reload(); await consent.waitFor(); await settle();
        assert.equal(await page.evaluate(() => window.__privacyFault), "", "reload removes injected fault and in-memory deny state");
        assert.equal(await consent.isChecked(), false, "persisted revocation survives clean reload");
        await add("privacy-remove-failed-reload-canary");
        await editBilling("2026-10-25");
        await editRenewal("유지", "keep");
        assert.equal(posts.length, 0, "reloaded tab fresh actions cannot send");
        console.log("EVIDENCE: failed-remove revocation: both tabs ON→OFF, clean reload OFF; intercepted marketing POSTs=0");
      } finally { await other.close(); }
    } else if (scenario.startsWith("storage-") || scenario === "failed-personal-save") {
      if (!["storage-read", "storage-consent-write"].includes(scenario)) await consent.check();
      await page.evaluate(fault => { window.__privacyFault = fault; }, scenario);
      if (["storage-read", "storage-consent-write"].includes(scenario)) {
        await consent.click(); // check() expects success, whereas refusal is required.
        await settle();
        assert.equal(await consent.isChecked(), false, "storage failure refuses consent");
      }
      if (scenario === "failed-personal-save") {
        const before = await count();
        await page.getByLabel("빠른 추가", { exact: true }).fill("privacy-failed-save-canary 98765원 매월");
        await page.getByRole("button", { name: "추가", exact: true }).click();
        await page.waitForFunction(() => window.__privacyFaultHits > 0);
        await settle();
        assert.equal(await count(), before, "failed save did not persist optimistic UI data");
      } else {
        await add("privacy-storage-canary");
        await editBilling("2026-10-21");
        await editRenewal("해지 예정", "cancel-planned");
      }
      assert.ok(await page.evaluate(() => window.__privacyFaultHits > 0), "fault actually exercised");
      assert.equal(posts.length, 0, "storage/failed-save faults must fail closed");
      if (scenario === "failed-personal-save") {
        await page.reload(); await consent.waitFor(); await settle();
        assert.equal(posts.length, 0, "failed save never replays after reload");
      }
    } else if (scenario === "cross-tab") {
      await consent.check();
      const other = await context.newPage();
      try {
        await other.clock.install();
        await other.goto(landing.href);
        await waitForConsent(other, true);
        await consentControl(other).uncheck();
        // A real same-context tab emits the browser storage event; no synthetic event.
        await waitForConsent(page, false);
        await add("privacy-cross-tab-canary");
        await editBilling("2026-10-22");
        await editRenewal("해지 예정", "cancel-planned");
        assert.equal(posts.length, 0, "cross-tab revocation blocks all previously unsent events");
      } finally { await other.close(); }
    } else if (scenario === "inflight-abort") {
      await consent.check();
      await add("privacy-inflight-canary");
      await page.waitForFunction(() => window.__marketingFetches.length === 1);
      await waitForPostCount(1);
      assert.equal(posts.length, 1, "actual network request held pending by harness");
      const failed = page.waitForEvent("requestfailed", { predicate: request => new URL(request.url()).pathname.endsWith("/marketing/events") });
      await consent.uncheck();
      await page.waitForFunction(() => window.__marketingFetches[0].aborted);
      await failed;
      await editBilling("2026-10-23");
      await editRenewal("해지 예정", "cancel-planned");
      await page.reload(); await consent.waitFor(); await settle();
      assert.equal(posts.length, 1, "aborted in-flight request is not retried or followed by unsent milestones");
    } else if (scenario === "disable-unsent") {
      // No dedup entries exist: revocation, not already-sent suppression, must
      // prevent these first eligible milestones (including after reload).
      await consent.check(); await settle();
      await consent.uncheck();
      await add("privacy-revoked-unsent-canary");
      await editBilling("2026-10-19");
      await editRenewal("해지 예정", "cancel-planned");
      assert.equal(posts.length, 0, "disable blocks previously unsent milestones");
      await page.reload(); await consent.waitFor(); await settle();
      assert.equal(await consent.isChecked(), false);
      await add("privacy-revoked-reloaded-canary");
      await editBilling("2026-10-20");
      await editRenewal("유지", "keep");
      assert.equal(posts.length, 0, "disable+reload blocks milestones without dedup masking the gate");
    } else {
      await consent.check(); await settle();
      assert.equal(posts.length, 0, "opt-in must not replay existing data");
      const beforePlaceholder = await page.evaluate(() => {
        const id = localStorage.getItem("living-cost-manager:active-user:v1");
        const data = JSON.parse(localStorage.getItem("living-cost-manager:user:" + encodeURIComponent(id) + ":v1"));
        return data.fixedCosts.map(cost => cost.id);
      });
      await page.getByRole("button", { name: "항목 추가", exact: true }).click();
      await page.waitForFunction(previousIds => {
        const id = localStorage.getItem("living-cost-manager:active-user:v1");
        const data = JSON.parse(localStorage.getItem("living-cost-manager:user:" + encodeURIComponent(id) + ":v1"));
        const added = data.fixedCosts.filter(cost => !previousIds.includes(cost.id));
        return data.fixedCosts.length === previousIds.length + 1 && added.length === 1 &&
          added[0].name === "새 고정비" && added[0].amount === 0;
      }, beforePlaceholder);
      await settle();
      assert.equal(posts.length, 0, "persisted empty Add placeholder must not emit or consume first-value cost event");
      await page.getByRole("button", { name: "분리된 샘플 체험", exact: true }).click();
      await add("privacy-sample-canary");
      await editBilling("2026-10-14");
      await editRenewal("해지 예정", "cancel-planned");
      assert.equal(posts.length, 0, "sample cost/billing/renewal actions excluded before personal dedup exists");
      await page.getByRole("button", { name: "내 데이터로 시작 / 돌아가기", exact: true }).click();
      await add("privacy-optin-canary");
      await waitForPostCount(1);
      assert.equal(posts.length, 1, "personal successful save sends once");
      assert.equal(validatePayload(posts[0].body), "personal_cost_saved", "valid Quick Add still owns the first-value cost milestone after placeholder");
      console.log(`EVIDENCE (${scenario}): opted-in persisted empty Add placeholder POSTs=0; subsequent valid personal Quick Add POSTs=1 (personal_cost_saved)`);
      await editBilling("2026-10-15");
      await editRenewal("해지 예정", "cancel-planned");
      await waitForPostCount(3);
      assert.deepEqual(posts.map(post => validatePayload(post.body)), events, "three actual save milestones");
      for (const post of posts) {
        assert.ok(!/privacy-.*canary|98765/.test(JSON.stringify(post)), "no financial/name/campaign canary in any request field");
        const url = new URL(post.url);
        assert.equal(url.search, ""); assert.equal(url.hash, "");
        assert.ok(url.pathname.endsWith("/marketing/events"));
        assert.equal(post.method, "POST");
        for (const header of ["cookie", "authorization", "referer"]) assert.equal(post.headers[header], undefined, `${header} forbidden`);
      }
      const fetches = await page.evaluate(() => window.__marketingFetches);
      assert.equal(fetches.length, 3, "observe actual fetch config for every event");
      for (const request of fetches) {
        assert.deepEqual(request.headers, ["content-type"], "no custom identifying headers");
        assert.equal(request.credentials, "omit");
        assert.ok(request.referrer === "" || request.referrerPolicy === "no-referrer", "no referrer policy required");
      }
      await add("privacy-dedup-canary");
      await editBilling("2026-10-16");
      await editRenewal("유지", "keep");
      assert.equal(posts.length, 3, "cost/billing/renewal dedup after success or delivery failure");
      await page.reload(); await consent.waitFor(); await settle();
      assert.equal(posts.length, 3, "reload has no historical replay/retry");
      await consent.uncheck();
      await add("privacy-disabled-canary");
      await editBilling("2026-10-17");
      await editRenewal("해지 예정", "cancel-planned");
      assert.equal(posts.length, 3, "disable stops future events");
      await page.reload(); await consent.waitFor(); await settle();
      assert.equal(await consent.isChecked(), false, "disable persists");
      await add("privacy-disabled-reload-canary");
      await editBilling("2026-10-18");
      await editRenewal("유지", "keep");
      assert.equal(posts.length, 3, "disable+reload stops fresh cost/billing/renewal saves and delayed sends");
    }
    assert.deepEqual(unexpected, [], "no unexpected transport (including financial data)");
    assert.deepEqual(errors, [], "no uncaught runtime failures");
  } finally {
    if (knownExternalBlocked.length) {
      console.log(`INFRASTRUCTURE BLOCKED (${scenario}): ${knownExternalBlocked.length} pre-existing Cloudflare script attempt(s); script not executed, no egress permitted: ${[...new Set(knownExternalBlocked)].join(", ")}`);
    }
    for (const route of heldRoutes) await route.abort().catch(() => {});
    await context.close();
  }
}
