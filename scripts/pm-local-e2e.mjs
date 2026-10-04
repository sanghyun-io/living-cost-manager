// Local browser-only journey; no API session is created. External requests are blocked.
// PLAYWRIGHT_MODULE may point to an existing local Playwright installation.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.LCM_E2E_ORIGIN || "http://127.0.0.1:3317";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const context = await browser.newContext({ acceptDownloads: true });
const errors = [];
await context.route("**/*", async (route) => {
  if (new URL(route.request().url()).origin !== origin) {
    errors.push("Blocked external request: " + route.request().url());
    return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
await page.clock.install({ time: new Date("2026-10-03T12:00:00+09:00") });
const snapshot = () => page.evaluate(() => {
  const id = localStorage.getItem("living-cost-manager:active-user:v1");
  return JSON.parse(localStorage.getItem("living-cost-manager:user:" + encodeURIComponent(id) + ":v1"));
});
async function waitFor(check, message) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
try {
  await page.goto(origin);
  await page.getByText("아직 등록된 고정비가 없어요", { exact: true }).waitFor();
  assert.equal((await snapshot()).fixedCosts.length, 0);
  await page.getByLabel("빠른 추가", { exact: true }).fill("연간 도구 120000원 매년");
  await page.getByRole("button", { name: "추가", exact: true }).click();
  await page.getByLabel("항목명", { exact: true }).waitFor();
  await waitFor(async () => (await snapshot()).fixedCosts.length === 1, "registration persisted");
  let cost = (await snapshot()).fixedCosts[0];
  assert.equal(cost.periodMonths, 12);
  assert.equal(cost.billingAnchorDate ?? null, null);
   await page.getByText(/다음 납부일 미확인: 실제 청구/).waitFor();
  await page.getByLabel(/기준 납부일/).fill("2026-10-04");
  await waitFor(async () => (await snapshot()).fixedCosts[0].billingAnchorDate === "2026-10-04", "anchor persisted");
  const insights = page.getByRole("region", { name: "예측 및 절감 인사이트" });
  await insights.getByText("앞으로 30일 실제 납부 예정", { exact: true }).waitFor();
  await insights.getByText(/120,000.*1회/).waitFor();
  await page.getByRole("button", { name: "분리된 샘플 체험", exact: true }).click();
  await waitFor(async () => (await snapshot()).fixedCosts.length === 5, "sample profile loaded");
  await page.getByRole("button", { name: "내 데이터로 시작 / 돌아가기", exact: true }).click();
  await waitFor(async () => (await snapshot()).fixedCosts.length === 1, "real data preserved");
  assert.equal((await snapshot()).fixedCosts[0].billingAnchorDate, "2026-10-04");
  await page.getByRole("textbox", { name: "갱신 검토", exact: true }).click();
  await page.getByRole("option", { name: "해지 예정", exact: true }).click();
  await page.getByLabel("예상 월 절감액", { exact: true }).fill("10000");
  await waitFor(async () => (await snapshot()).fixedCosts[0].renewalStatus === "cancel-planned", "review persisted");
  assert.equal((await snapshot()).fixedCosts[0].confirmedMonthlySavings ?? 0, 0);
  await page.getByRole("button", { name: "해지 완료 확인", exact: true }).click();
  await waitFor(async () => (await snapshot()).fixedCosts[0].renewalStatus === "completed", "completion persisted");
  cost = (await snapshot()).fixedCosts[0];
  assert.equal(cost.amount, 0);
  assert.equal(cost.confirmedMonthlySavings, 10000);
  await page.reload();
  await page.getByLabel("직접 확인한 월 절감액", { exact: true }).waitFor();
  assert.equal((await snapshot()).fixedCosts[0].confirmedMonthlySavings, 10000);
  // Exercise the actual hook with a file read that completes after profile switch.
  await page.locator("header").getByRole("button", { name: "데이터 관리", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "전체 Export", exact: true }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = Buffer.concat(chunks);
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      const file = this;
      return new Promise((resolve) => { window.releaseImport = async () => resolve(await original.call(file)); });
    };
  });
  await page.locator('input[type="file"][accept=".lcm,text/plain"]').setInputFiles({ name: "saved.lcm", mimeType: "text/plain", buffer: exported });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "분리된 샘플 체험", exact: true }).click();
  await waitFor(async () => (await snapshot()).fixedCosts.length === 5, "sample ready during import");
  await page.evaluate(() => window.releaseImport());
  await page.waitForTimeout(100);
  assert.equal((await snapshot()).fixedCosts.length, 5, "late import must not replace another profile");
  await page.getByRole("button", { name: "내 데이터로 시작 / 돌아가기", exact: true }).click();
  await waitFor(async () => (await snapshot()).fixedCosts.length === 1, "real profile restored");
  const corrupt = await page.evaluate(() => {
    const key = "living-cost-manager:user:" + encodeURIComponent(localStorage.getItem("living-cost-manager:active-user:v1")) + ":v1";
    const value = JSON.parse(localStorage.getItem(key));
    value.fixedCosts[0].billingAnchorDate = "2026-02-30";
    const original = JSON.stringify(value);
    localStorage.setItem(key, original);
    return { key, original };
  });
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.includes(":corrupt:")) throw new DOMException("Injected recovery-copy quota failure", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.reload();
  await page.getByText(/복구 사본을 저장하지 못해 원본 보호를 위해 자동 저장을 중단/).waitFor();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), corrupt.key), corrupt.original, "failed recovery copy never overwrites original");
  const originalDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "저장 원본 내보내기", exact: true }).click();
  const originalStream = await (await originalDownload).createReadStream();
  const rawChunks = [];
  for await (const chunk of originalStream) rawChunks.push(chunk);
  assert.equal(Buffer.concat(rawChunks).toString(), corrupt.original);
  assert.deepEqual(errors, []);
  console.log("PASS: blank start, annual add, unknown schedule, 30-day full charge, anchor, sample isolation, renewal/confirmed savings, reload/export, late import/profile safety, corrupt-copy quota failure preserves/export original; zero external requests/runtime errors");
} finally {
  await context.close();
  await browser.close();
}
