// Run against a LOCAL dev server only. Every billing/auth/SDK response is synthetic.
// NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3199/fixture-api pnpm --filter @living-cost-manager/web dev --port 3199
// node apps/web/tests/subscription-browser.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true });
const browserUrl = process.env.LCM_BROWSER_URL ?? "http://localhost:3199";
const fixtureApi = new URL(process.env.LCM_FIXTURE_API_BASE ?? "http://127.0.0.1:3199/fixture-api");
const context = await browser.newContext();
const page = await context.newPage();
const failures = [];
const requests = [];
page.on("requestfailed", request => requests.push(`${request.url()} ${request.failure()?.errorText}`));
page.on("console", msg => { if (msg.type() === "error") requests.push(msg.text()); });
page.on("pageerror", error => failures.push(error.message));
let enabled = false, missing = false, prepare = 0, charges = 0, sdkLoads = 0;
let meRequests = 0, meMode = "ok";
let environment = "sandbox", subscriptionOverride = null;
const subscription = { contractId: null, planId: null, status: "free", paidAccess: false, paidThrough: null,
  nextChargeAt: null, cancelAtPeriodEnd: false, renewalStopped: false, providerCancellationStatus: "unconfirmed", existingFreeAccess: true };
const readiness = () => ({ mode: environment, checkoutEnabled: enabled, blockingCodes: enabled ? [] : ["COMMERCE_PENDING"], catalogVersion: "browser-fixture",
  currency: "KRW", taxTreatment: "inclusive", catalog: { monthly: { totalAmount: 990, periodMonths: 1 }, annual: { totalAmount: 9900, periodMonths: 12 } },
  consentVersions: { billing: "fixture-billing", autoRenew: "fixture-renew" }, capabilities: { issueInstrument: true, charge: true, renew: true, cancel: true, refund: true },
  sdkConfig: { storeId: "fixture-store", channelId: "fixture-channel" }, approvals: { merchant: true, commerce: true, legal: true, featureScope: true } });
const quote = { quoteId: "browser-quote", planId: "monthly", catalogVersion: "browser-fixture", totalAmount: 990, currency: "KRW", periodMonths: 1,
  expiresAt: new Date(Date.now() + 3600000).toISOString(), mode: "sandbox", featureScopeVersion: "fixture-scope", policyVersion: "fixture-policy",
  featureScope: { version: "fixture-scope", text: "Synthetic test scope" }, billingConsent: { version: "fixture-billing", text: "테스트 결제 조건 확인" },
  autoRenewConsent: { version: "fixture-renew", text: "테스트 자동 갱신 확인" }, sellerDisclosure: { version: "fixture-seller", text: "Synthetic seller" },
  policyDisclosure: { version: "fixture-policy", text: "Synthetic policy" }, nextChargeAt: new Date(Date.now() + 2678400000).toISOString(), nextChargeAmount: 990 };
const attempt = { attemptId: "browser-attempt", status: "paid", mode: "sandbox", paidAt: new Date().toISOString(), totalAmount: 990, currency: "KRW" };
await context.addInitScript(() => localStorage.setItem("living-cost-manager:server-session:v2", JSON.stringify({ token: "fixture-token", refreshToken: "fixture-refresh", user: { id: "fixture-account" }, workspace: null })));
await context.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.href === "https://cdn.portone.io/v2/browser-sdk.js") {
    sdkLoads++;
    await route.fulfill({ contentType: "application/javascript", body: "window.PortOne={requestIssueBillingKey:async()=>({billingKey:'synthetic-browser-secret'})};" }); return;
  }
  const fixture = url.origin === fixtureApi.origin && url.pathname.startsWith(`${fixtureApi.pathname}/`);
  // Exact configured API is fulfilled locally, even when testing the production build URL.
  // NEVER continue a production/API/provider request onto the network.
  if (!fixture) {
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") await route.abort();
    else await route.continue();
    return;
  }
  const cors = { "access-control-allow-origin": new URL(browserUrl).origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type" };
  if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
  const path = url.pathname.slice(fixtureApi.pathname.length);
  let body;
  if (path === "/me") {
    meRequests++;
    if (meMode === "503") { await route.fulfill({ status: 503, headers: cors, body: "synthetic unavailable" }); return; }
    if (meMode === "timeout") { await new Promise(resolve => setTimeout(resolve, 16000)); }
    body = { user: { id: "fixture-account" } };
  }
  else if (missing) { await route.fulfill({ status: 404, headers: cors, body: "not registered" }); return; }
  else if (path.endsWith("/readiness")) body = readiness();
  else if (path.endsWith("/subscription")) body = subscriptionOverride ?? subscription;
  else if (path.endsWith("/quotes")) { await new Promise(resolve => setTimeout(resolve, 120)); body = quote; }
  else if (path.endsWith("/instruments/prepare")) { prepare++; body = { instrumentId: "fixture-instrument", sdkRequest: { storeId: "fixture-store", channelKey: "fixture-channel", issueId: "fixture-issue", customer: { customerId: "fixture-opaque" }, billingKeyMethod: "CARD" } }; }
  else if (path.endsWith("/confirm")) body = { confirmed: true };
  else if (path.endsWith("/charges")) { charges++; body = attempt; }
  else if (path.endsWith("/attempts/browser-attempt")) body = attempt;
  else if (path.endsWith("/refund-requests")) body = { requestId: "fixture-refund", status: "requested" };
  else { await route.fulfill({ status: 404, body: "fixture route unavailable" }); return; }
  await route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify(body) });
});
try {
  meMode = "503";
  await page.goto(`${browserUrl}/subscription/`);
  await page.getByRole("status").filter({ hasText: "로그인 상태를 확인하지 못했습니다" }).waitFor();
  const firstFailure = meRequests;
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("focus")); });
  assert.equal(meRequests, firstFailure, "focus storm is throttled after transient failure");
  await page.waitForTimeout(5100); meMode = "ok";
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("focus")); });
  await page.getByRole("status").filter({ hasText: "현재 결제 신청" }).waitFor();
  await page.getByRole("button", { name: "로그인 상태 확인됨" }).waitFor();
  assert.equal(meRequests, firstFailure + 1, "same valid token recovers once");
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("focus")); });
  assert.equal(meRequests, firstFailure + 1, "verified identity cached");
  environment = "live";
  subscriptionOverride = { ...subscription, status: "UNKNOWN_FUTURE_STATUS", paidAccess: true, contractId: "synthetic-unknown", planId: "monthly", paidThrough: new Date(Date.now() + 2678400000).toISOString() };
  await page.reload();
  await page.getByRole("status").filter({ hasText: "정보를 확인하지 못했습니다" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "현재 이용 상태" }).count(), 0, "unknown live status cannot display verified entitlement");
  assert.equal(await page.getByRole("button", { name: "월간 견적 확인" }).getAttribute("aria-disabled"), "true");
  environment = "sandbox"; subscriptionOverride = null;
  meMode = "timeout"; await page.reload();
  await page.getByRole("status").filter({ hasText: "로그인 상태를 확인하지 못했습니다" }).waitFor({ timeout: 20000 });
  assert.equal(await page.getByText("구독 조회는 로그인 후", { exact: false }).count(), 0, "timeout is unavailable, not logged out");
  await page.waitForTimeout(5100); meMode = "ok";
  const retryButton = page.getByRole("button", { name: "로그인 상태 다시 확인" });
  await retryButton.focus(); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "로그인 상태 확인됨" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "로그인 상태 확인됨" }).evaluate(el => document.activeElement === el), true, "retry button stays mounted and focused");
  assert.equal(sdkLoads, 0); assert.equal(prepare, 0); assert.equal(charges, 0);
  assert.equal(await page.getByRole("button", { name: "월간 견적 확인" }).getAttribute("aria-disabled"), "true");
  missing = true; await page.reload();
  await page.getByRole("status").filter({ hasText: "결제 준비 중" }).waitFor();
  await page.setViewportSize({ width: 360, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.getByRole("link", { name: "생활비 화면으로 돌아가기" }).getAttribute("href"), "/");
  missing = false; enabled = true; await page.reload();
  await page.getByRole("status").filter({ hasText: "금액과 조건" }).waitFor();
  const quoteButton = page.getByRole("button", { name: "월간 견적 확인" });
  await quoteButton.focus(); await page.keyboard.press("Enter");
  await page.getByText("Synthetic test scope").waitFor();
  assert.equal(await quoteButton.evaluate(el => document.activeElement === el), true, "quote async keeps initiating focus");
  const billing = page.getByLabel("테스트 결제 조건 확인", { exact: false });
  const renewal = page.getByLabel("테스트 자동 갱신 확인", { exact: false });
  assert.equal(await billing.isChecked(), false); assert.equal(await renewal.isChecked(), false);
  await billing.check(); await renewal.check();
  const pay = page.getByRole("button", { name: /カード|카드 등록 후 청구 요청/ });
  await pay.focus(); await page.keyboard.press("Enter");
  await page.getByRole("status").filter({ hasText: "테스트 결제 결과" }).waitFor();
  assert.equal(await pay.evaluate(el => document.activeElement === el), true, "charge async keeps focus");
  await pay.evaluate(el => { el.click(); el.click(); });
  assert.equal(charges, 1); assert.equal(sdkLoads, 1); assert.equal(prepare, 1);
  assert.equal(await page.getByText("확인된 유료 권한 없음").count(), 1);
  assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage }).includes("synthetic-browser-secret")), false);
  assert.equal(await page.locator('input[type="text"], input[type="password"], input[type="number"]').count(), 0);
  await page.getByLabel("위 결제에 대한 환불 검토").check();
  await page.getByRole("button", { name: "환불 검토 요청", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "완료나 승인 안내가 아닙니다" }).waitFor();
  // Account logout hides the previous account immediately; only synthetic session removed.
  await page.evaluate(() => { localStorage.removeItem("living-cost-manager:server-session:v2"); window.dispatchEvent(new Event("storage")); });
  await page.getByText("구독 조회는 로그인 후", { exact: false }).waitFor();
  assert.equal(await page.getByText("서버 결제 확인", { exact: false }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(failures, []);
  console.log("PASS: intercepted-only browser unknown-live-subscription rejection, 503/held-timeout recovery, focus retry throttle/cache, 404/OFF, mobile, keyboard/focus, separate consent, duplicate click, synthetic SDK, authoritative result, refund request, logout privacy.");
} catch (error) {
  console.error("Synthetic page diagnostics:", await page.locator("body").innerText(), failures, requests);
  throw error;
} finally { await browser.close(); }
