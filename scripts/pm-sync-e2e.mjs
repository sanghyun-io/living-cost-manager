// Local isolated API/DB only. API fixture verification never targets production.
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { assertVerificationTarget } from "./verification-target.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.LCM_E2E_ORIGIN || "http://127.0.0.1:3318";
const api = process.env.LCM_E2E_API || "http://127.0.0.1:4318";
assert.equal(new URL(origin).hostname, "127.0.0.1");
assert.equal(new URL(api).hostname, "127.0.0.1");
const databaseUrl = await assertVerificationTarget(process.env);
const target = new URL(databaseUrl);
assert.equal(target.hostname, "127.0.0.1");
assert.ok(Number(target.port) > 0);
assert.equal(target.pathname, "/lcm_test");
assert.equal(target.searchParams.get("schema"), "lcm_test");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const email = `pm-e2e-${crypto.randomUUID()}@example.test`;
const password = "local-test-password-123";
const registration = await fetch(api + "/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, name: "PM E2E" }) });
assert.equal(registration.status, 201);
const fixture = await registration.json();
await prisma.user.update({ where: { id: fixture.user.id }, data: { emailVerifiedAt: new Date() } });
const login = await fetch(api + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
const session = await login.json();
const headers = { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" };
const snapshotUrl = api + `/workspaces/${fixture.workspace.id}/snapshot`;
const getRemote = async () => (await fetch(snapshotUrl, { headers })).json();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
await context.route("**/*", async (route) => {
  if (![origin, api].includes(new URL(route.request().url()).origin)) {
    errors.push("external request blocked"); return route.abort();
  }
  return route.continue();
});
const local = () => page.evaluate(() => JSON.parse(localStorage.getItem("living-cost-manager:user:" + encodeURIComponent(localStorage.getItem("living-cost-manager:active-user:v1")) + ":v1")));
async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(label);
}
const openData = async () => {
  if (await page.getByRole("dialog", { name: /데이터 관리/ }).isVisible()) return;
  await page.locator("header.app-header").getByRole("button", { name: /^(데이터 관리|서버 연결됨 · 동기화 관리)$/ }).click();
};
const closeData = async () => {
  await page.getByRole("button", { name: "데이터 관리 닫기", exact: true }).click();
  await page.getByRole("dialog", { name: /데이터 관리/ }).waitFor({ state: "hidden" });
};
try {
  await page.goto(origin);
  await page.locator("header").getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("dialog").getByRole("button", { name: "로그인", exact: true }).click();
  await waitFor(async () => await page.evaluate(() => localStorage.getItem("living-cost-manager:active-user:v1")) === "server:" + fixture.user.id, "authenticated profile selected");
  await page.getByRole("dialog", { name: "클라우드 로그인", exact: true }).waitFor({ state: "hidden" });
  await closeData();
  await page.getByLabel("빠른 추가", { exact: true }).fill("동기화 구독 120000원 매년");
  await page.getByRole("button", { name: "추가", exact: true }).click();
  await page.getByLabel(/기준 납부일/).fill("2026-10-04");
  await openData();
  await page.getByRole("button", { name: "이 브라우저 데이터 업로드", exact: true }).click();
  await waitFor(async () => (await getRemote()).fixedCosts[0]?.billingAnchorDate === "2026-10-04", "manual baseline saved");
  const automatic = page.getByRole("checkbox", { name: /변경사항 자동 업로드/ });
  await automatic.check();
  await closeData();
  await page.getByLabel("금액", { exact: true }).fill("240000");
  await waitFor(async () => (await getRemote()).fixedCosts[0]?.amount === 240000, "automatic upload saved");
  const remote = await getRemote();
  remote.fixedCosts[0].amount = 360000;
  assert.equal((await fetch(snapshotUrl, { method: "PUT", headers, body: JSON.stringify(remote) })).status, 200);
  await page.getByLabel("금액", { exact: true }).fill("480000");
  await openData();
  await page.getByText(/다른 기기나 멤버가 먼저 저장해 충돌/).waitFor();
  assert.equal(await automatic.isChecked(), false);
  assert.equal((await getRemote()).fixedCosts[0].amount, 360000);
  assert.equal((await local()).fixedCosts[0].amount, 480000);
  await page.getByRole("button", { name: "서버 데이터 불러오기", exact: true }).click();
  await waitFor(async () => (await local()).fixedCosts[0].amount === 360000, "fresh load selected");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(":recovery:")).length), 1);
  let releaseLoad;
  let loadWaiting = false;
  await page.route(snapshotUrl, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => { releaseLoad = resolve; loadWaiting = true; });
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole("button", { name: "서버 데이터 불러오기", exact: true }).click();
  await waitFor(() => loadWaiting, "delayed snapshot started");
  await closeData();
  await page.getByLabel("금액", { exact: true }).fill("500000");
  releaseLoad();
  await openData();
  await page.getByText(/불러오는 동안 로컬 데이터가 변경되어/).waitFor();
  assert.equal((await local()).fixedCosts[0].amount, 500000, "late snapshot cannot overwrite edits");
  await page.getByRole("button", { name: "서버 데이터 불러오기", exact: true }).click();
  await waitFor(async () => (await local()).fixedCosts[0].amount === 360000, "explicit retry restored remote");
  await closeData();
  // Returning from demo must restore this server-linked local profile, without reconnecting it.
  await page.getByRole("button", { name: "분리된 샘플 체험", exact: true }).click();
  await page.getByRole("button", { name: "내 데이터로 시작 / 돌아가기", exact: true }).click();
  await waitFor(async () => (await local()).fixedCosts[0]?.amount === 360000, "sample returns to originating profile");
  await page.locator("header").getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("dialog").getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByRole("button", { name: "계정 삭제…", exact: true }).waitFor();
  const otherTab = await context.newPage();
  await otherTab.goto(origin);
  await otherTab.getByLabel("금액", { exact: true }).waitFor();
  await otherTab.getByLabel("빠른 추가", { exact: true }).fill("삭제전 기록 100원 매달");
  await otherTab.getByRole("button", { name: "추가", exact: true }).click();
  await page.getByRole("button", { name: "계정 삭제…", exact: true }).click();
  await page.getByLabel("비밀번호 재확인", { exact: true }).fill(password);
  await page.getByRole("button", { name: "계속 (단계 1/2)", exact: true }).click();
  await page.getByRole("button", { name: "영구 삭제 (단계 2/2)", exact: true }).click();
  await otherTab.getByText(/다른 탭에서 계정이 삭제되어 저장과 동기화를 중단/).waitFor();
  await new Promise((r) => setTimeout(r, 5500));
  const remainingEvents = await otherTab.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("lcm-analytics", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const count = db.transaction("events").objectStore("events").count();
      count.onsuccess = () => { resolve(count.result); db.close(); };
    };
  }));
  assert.equal(remainingEvents, 0, "pending events in another tab must not resurrect after erasure");
  await otherTab.getByLabel("빠른 추가", { exact: true }).fill("삭제후 저장차단 100원 매달");
  await otherTab.getByRole("button", { name: "추가", exact: true }).click();
  assert.equal(await otherTab.evaluate((id) => localStorage.getItem("living-cost-manager:user:" + encodeURIComponent("server:" + id) + ":v1"), fixture.user.id), null);
  await otherTab.getByRole("button", { name: "분리된 샘플 체험", exact: true }).click();
  await otherTab.getByRole("button", { name: "내 데이터로 시작 / 돌아가기", exact: true }).click();
  assert.equal(await otherTab.evaluate((id) => localStorage.getItem("living-cost-manager:user:" + encodeURIComponent("server:" + id) + ":v1"), fixture.user.id), null);
  assert.equal(await otherTab.evaluate((id) => JSON.parse(localStorage.getItem("living-cost-manager:users:v1")).some((user) => user.serverUserId === id), fixture.user.id), false);
  assert.deepEqual(errors, []);
  console.log("PASS: real local API login, manual baseline, automatic upload, conflict preserves both copies, recovery load, edit-during-load protection, profile return/relogin, actual account deletion and cross-tab budget/analytics erasure");
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-8000));
  throw error;
} finally {
  await browser.close();
  // Only this newly created fixture account, on the explicitly guarded ephemeral DB.
  await prisma.workspace.deleteMany({ where: { id: fixture.workspace.id } });
  await prisma.user.deleteMany({ where: { id: fixture.user.id } });
  await prisma.$disconnect();
}
