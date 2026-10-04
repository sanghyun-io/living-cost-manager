import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.LCM_E2E_ORIGIN;
assert.equal(new URL(origin).hostname, "127.0.0.1");
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    const errors = [];
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin) { errors.push("External request blocked"); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    const local = () => page.evaluate(() => JSON.parse(localStorage.getItem("living-cost-manager:user:" + encodeURIComponent(localStorage.getItem("living-cost-manager:active-user:v1")) + ":v1")));
    const rows = () => page.getByRole("group", { name: "고정비 목록", exact: true }).locator(".table-row:not(.table-head)");
    const quick = page.getByLabel("빠른 추가", { exact: true });
    const openData = () => page.locator("header").getByRole("button", { name: "데이터 관리", exact: true }).click();
    async function download(button) {
      const waiting = page.waitForEvent("download"); await button.click();
      const stream = await (await waiting).createReadStream(); const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    try {
      await page.goto(origin);
      await quick.waitFor();
      await waitFor(async () => (await local()) !== null, "initial budget persisted");
      await page.keyboard.press("Tab");
      assert.equal(await page.getByRole("link", { name: "고정비 편집으로 건너뛰기" }).evaluate(el => el === document.activeElement), true);
      await page.keyboard.press("Enter");
      await quick.fill("이름만");
      assert.equal(await page.getByRole("button", { name: "추가", exact: true }).isDisabled(), true);
      await quick.press("Enter"); assert.equal(await quick.inputValue(), "이름만");
      assert.equal((await local()).fixedCosts.length, 0);
      await quick.fill("연간 도구 120000원 매년");
      await page.getByText(/미리보기: 연간 도구 · .*120,000.* · 12개월/).waitFor();
      await quick.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      assert.equal((await local()).fixedCosts.length, 0);
      await quick.press("Enter");
      await waitFor(async () => (await local()).fixedCosts.length === 1, "quick entry saved");
      assert.equal(await page.getByLabel("항목명", { exact: true }).evaluate(el => el === document.activeElement), true);
      const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
      await page.getByLabel(/기준 납부일/).fill(today);
      await page.getByRole("button", { name: "연간 도구 · 임박 미검토 편집", exact: true }).click();
      assert.equal(await page.getByLabel("항목명", { exact: true }).evaluate(el => el === document.activeElement), true);
      await page.getByRole("button", { name: "연간 도구 복제", exact: true }).click();
      await waitFor(async () => (await local()).fixedCosts.length === 2, "duplicate saved");
      const duplicated = (await local()).fixedCosts;
      assert.notEqual(duplicated[0].id, duplicated[1].id); assert.equal(duplicated[1].renewalStatus, "unreviewed");
      await page.getByLabel("이름 검색", { exact: true }).fill("없는 항목");
      await page.getByText("조건에 맞는 항목이 없어요. 필터를 초기화해 보세요.").waitFor();
      await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
      await waitFor(async () => (await rows().count()) === 2, "filters reset");
      await page.getByRole("button", { name: "삭제 모드", exact: true }).click();
      await rows().nth(1).getByLabel("삭제 선택", { exact: true }).check();
      await page.getByRole("button", { name: "선택 삭제", exact: true }).click();
      await page.getByLabel("금액", { exact: true }).fill("240000");
      await page.getByRole("button", { name: "최근 삭제 취소", exact: true }).click();
      await waitFor(async () => (await local()).fixedCosts.length === 2, "undo restored");
      assert.equal((await local()).fixedCosts[0].amount, 240000);
      // Fail only budget persistence, then export memory and recover without reload.
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        window.restoreStorage = () => { Storage.prototype.setItem = original; };
        Storage.prototype.setItem = function(key, value) { if (key.startsWith("living-cost-manager:user:")) throw new DOMException("Injected quota", "QuotaExceededError"); return original.call(this, key, value); };
      });
      await rows().first().getByLabel("금액", { exact: true }).fill("360000");
      await page.getByRole("button", { name: "브라우저 저장 재시도" }).waitFor();
      const unsaved = await download(page.getByRole("button", { name: "미저장 데이터 내보내기" }));
      assert.ok(unsaved.toString().includes("360000")); assert.equal((await local()).fixedCosts[0].amount, 240000);
      await page.evaluate(() => window.restoreStorage());
      await page.getByRole("button", { name: "브라우저 저장 재시도" }).click();
      await waitFor(async () => (await local()).fixedCosts[0].amount === 360000, "quota retry saved memory");
      await openData();
      const saved = await download(page.getByRole("button", { name: "전체 Export", exact: true }));
      const input = page.getByLabel("전체 백업 파일 가져오기", { exact: true });
      await input.setInputFiles({ name: "broken.lcm", mimeType: "text/plain", buffer: Buffer.from("broken") });
      await page.getByRole("dialog").getByText(/전체 백업 가져오기에 실패/).waitFor();
      await input.setInputFiles({ name: "saved.lcm", mimeType: "text/plain", buffer: saved });
      await page.getByText("가져오기 미리보기 · 현재 데이터 교체", { exact: true }).waitFor();
      await page.getByRole("button", { name: "가져오기 취소", exact: true }).click();
      assert.equal((await local()).fixedCosts.length, 2);
      await input.setInputFiles({ name: "saved.lcm", mimeType: "text/plain", buffer: saved });
      await page.getByRole("button", { name: "검증한 내용으로 교체 적용", exact: true }).click();
      await page.getByRole("dialog").getByText("검증한 2개 항목을 적용했습니다.").waitFor();
      await page.getByRole("button", { name: "데이터 관리 닫기", exact: true }).click();
      if (width === 390) {
        assert.ok(await rows().first().getByLabel("항목명", { exact: true }).evaluate(el => el.getBoundingClientRect().height >= 44));
        assert.ok(await rows().first().getByRole("button", { name: /복제/ }).evaluate(el => el.getBoundingClientRect().height >= 44));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow");
      await page.reload(); await quick.waitFor(); assert.equal((await local()).fixedCosts.length, 2);
      assert.deepEqual(errors, []);
      console.log(`PASS usability browser ${width}: preview/IME, focus, queue, duplicate, filter, undo, quota/export/retry, import/cancel/apply, accessibility, overflow, reload`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
