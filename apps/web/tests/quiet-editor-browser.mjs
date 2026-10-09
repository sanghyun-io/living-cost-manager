// All profiles are synthetic; no request can reach an API or customer account.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const root = resolve(process.env.QUIET_EDITOR_EXPORT ?? fileURLToPath(new URL('../out/', import.meta.url)));
const before = process.env.QUIET_EDITOR_BEFORE === '1';
const evidence = resolve(process.env.QUIET_EDITOR_EVIDENCE ?? resolve(tmpdir(), `quiet-editor-${randomUUID()}`));
await mkdir(evidence, { recursive: true, mode: 0o700 });
const server = createServer(async (req, res) => {
  try {
    let path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(root + '/') && path !== root) throw Error('outside export');
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' }[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [];
const userId = 'guest-quiet-fixture';
const storageKey = `living-cost-manager:user:${userId}:v1`;
const costs = count => Array.from({ length: count }, (_, i) => ({
  id: `quiet-cost-${i}`, name: `테스트 지출 ${i + 1}`, categoryId: 'other', paymentMethodId: 'bank-transfer',
  paymentOptionId: 'auto-transfer', amount: 12000 + i * 1000, periodMonths: 1, billingDay: 15,
  isEndOfMonth: false, billingAnchorDate: '2026-10-15', renewalStatus: 'unreviewed',
  potentialMonthlySavings: 0, confirmedMonthlySavings: 0
}));
async function fixture(count, width, scheme = 'light') {
  const context = await browser.newContext({ viewport: { width, height: width > 1000 ? 900 : 844 }, serviceWorkers: 'block' });
  const forbidden = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    forbidden.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ storageKey, fixedCosts, userId, scheme }) => {
    if (localStorage.getItem('quiet-seeded')) return;
    localStorage.setItem('quiet-seeded', '1');
    localStorage.setItem('mantine-color-scheme-value', scheme);
    localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id: userId, name: '테스트 사용자' }]));
    localStorage.setItem('living-cost-manager:active-user:v1', userId);
    localStorage.setItem(storageKey, JSON.stringify({ monthlyIncome: 3000000, categories: [{ id: 'other', label: '기타' }], cards: [], fixedCosts }));
  }, { storageKey, fixedCosts: costs(count), userId, scheme });
  await page.goto(origin);
  await page.locator('.cost-list').waitFor();
  await page.waitForFunction(count => document.querySelectorAll('.table-row:not(.table-head)').length === count, count);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, forbidden, errors };
}
async function snapshot(f, count, width, scheme) {
  const { page } = f;
  const name = `${before ? 'before' : 'after'}-${width}-${scheme}-${count}`;
  const firstRowTop = count ? await page.locator('.table-row:not(.table-head)').first().evaluate(el => el.getBoundingClientRect().top) : null;
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 1, `${name}: overflow ${overflow}`);
  await page.screenshot({ path: resolve(evidence, `${name}-viewport.png`), animations: 'disabled', fullPage: false });
  if (!before && count) assert.ok(firstRowTop < (width > 1000 ? 500 : 650), `${name}: first editor row below first fold at ${firstRowTop}`);
  if (count === 1 || count === 0) await page.screenshot({ path: resolve(evidence, `${name}-full.png`), animations: 'disabled', fullPage: true });
  if (!before) {
    assert.equal(await page.locator('.budget-strip').count(), 1);
    assert.equal(await page.locator('.hero-copy').count(), 0);
    assert.equal(await page.locator('.dashboard-overview').isVisible(), false);
    assert.equal(await page.locator('.renewal-actions').isVisible(), false);
    assert.equal(await page.locator('html').getAttribute('data-mantine-color-scheme'), scheme);
  }
  assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []);
  results.push({ count, width, scheme, firstRowTop, overflow, forbiddenRequests: 0, pageErrors: 0 });
}
try {
  for (const width of [320, 390, 768, 1440]) for (const scheme of ['light', 'dark']) {
    const f = await fixture(30, width, scheme);
    await snapshot(f, 30, width, scheme);
    await f.context.close();
  }
  if (!before) {
    for (const count of [0, 1, 10]) {
      const f = await fixture(count, 390);
      await snapshot(f, count, 390, 'light');
      await f.context.close();
    }
    const emptyDark = await fixture(0, 390, 'dark');
    await snapshot(emptyDark, 0, 390, 'dark'); await emptyDark.context.close();
    for (const width of [390, 1440]) {
      const zoom = await fixture(1, width);
      // Text-only resize: double computed text sizes, not control heights or CSS pixels.
      await zoom.page.evaluate(() => {
        const sizes = [...document.querySelectorAll('body *')].filter(el => el instanceof HTMLElement)
          .map(el => [el, parseFloat(getComputedStyle(el).fontSize)]);
        for (const [el, size] of sizes) el.style.fontSize = `${size * 2}px`;
      });
      const overflow = await zoom.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      await zoom.page.screenshot({ path: resolve(evidence, `after-${width}-text-200-percent.png`), animations: 'disabled' });
      assert.ok(overflow <= 1, `200% root text at ${width}: overflow ${overflow}`);
      assert.equal(await zoom.page.getByLabel('항목명', { exact: true }).isVisible(), true);
      assert.deepEqual(zoom.forbidden, []); assert.deepEqual(zoom.errors, []);
      results.push({ width, textScale: '200% computed text sizes', overflow });
      await zoom.context.close();
    }
    const f = await fixture(1, 390), { page } = f;
    const first = page.getByRole('group', { name: '테스트 지출 1', exact: true });
    await first.getByLabel('금액', { exact: true }).fill('18500');
    await first.getByLabel('금액', { exact: true }).blur();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).fixedCosts[0].amount === 18500, storageKey);
    await page.getByLabel('빠른 추가', { exact: true }).fill('새 지출 22000원 매달');
    await page.getByLabel('빠른 추가', { exact: true }).press('Enter');
    const added = page.getByRole('group', { name: '새 지출', exact: true });
    await added.waitFor();
    await page.waitForFunction(() => document.activeElement?.value === '새 지출');
    await page.reload(); await added.waitFor();
    assert.equal(await first.getByLabel('금액', { exact: true }).inputValue(), '18,500');
    await first.getByRole('button', { name: '테스트 지출 1 더보기', exact: true }).click();
    await page.getByRole('menuitem', { name: '테스트 지출 1 복제', exact: true }).click();
    const copy = page.getByRole('group', { name: '테스트 지출 1 (복사)', exact: true });
    await copy.waitFor();
    await page.waitForFunction(() => document.activeElement?.value === '테스트 지출 1 (복사)');
    const data = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
    assert.equal(data.fixedCosts.length, 3); assert.equal(new Set(data.fixedCosts.map(c => c.id)).size, 3);
    assert.equal(data.fixedCosts[0].name, '테스트 지출 1'); assert.equal(data.fixedCosts.at(-1).amount, 18500);
    await page.locator('.editor-tools > summary').click();
    await page.getByRole('button', { name: '삭제 모드', exact: true }).click();
    await copy.getByRole('checkbox', { name: '삭제 선택', exact: true }).check();
    page.once('dialog', d => d.dismiss());
    await page.getByRole('button', { name: '선택 삭제', exact: true }).click(); assert.equal(await copy.count(), 1);
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: '선택 삭제', exact: true }).click(); await copy.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '최근 삭제 취소', exact: true }).click(); await copy.waitFor();
    await copy.getByLabel('갱신 검토', { exact: true }).click();
    await page.getByRole('option', { name: '해지 예정', exact: true }).click();
    await copy.getByLabel('예상 월 절감액', { exact: true }).fill('1000');
    await copy.getByLabel('예상 월 절감액', { exact: true }).blur();
    page.once('dialog', d => d.dismiss());
    await copy.getByRole('button', { name: '해지 완료 확인', exact: true }).click();
    assert.equal(await copy.getByLabel('금액', { exact: true }).inputValue(), '18,500');
    page.once('dialog', d => d.accept());
    await copy.getByRole('button', { name: '해지 완료 확인', exact: true }).click();
    await copy.getByLabel('직접 확인한 월 절감액', { exact: true }).waitFor();
    assert.equal(await copy.getByLabel('금액', { exact: true }).inputValue(), '0');
    assert.equal(await copy.getByLabel('직접 확인한 월 절감액', { exact: true }).inputValue(), '18500');
    assert.equal(await copy.getByLabel('테스트 지출 1 (복사) 기준 납부일', { exact: true }).inputValue(), '');
    assert.equal(await first.getByLabel('금액', { exact: true }).inputValue(), '18,500');
    await page.getByLabel('이름 검색', { exact: true }).fill('새 지출');
    assert.equal(await page.locator('.table-row:not(.table-head)').count(), 1);
    await page.locator('.editor-filters > summary').click();
    await page.getByRole('button', { name: '필터 초기화', exact: true }).click();
    assert.equal(await page.locator('.table-row:not(.table-head)').count(), 3);
    await page.getByRole('button', { name: '도구', exact: true }).click();
    await page.getByRole('menuitem', { name: '지출 코치', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.textContent === '도구');
    await page.locator('.workspace-tools > summary').click();
    await page.getByRole('button', { name: '분리된 샘플 체험', exact: true }).click();
    await page.getByText('샘플 체험 중 · 내 데이터와 분리된 예시입니다.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '내 데이터로 시작 / 돌아가기', exact: true }).click(); await first.waitFor();
    assert.equal(await first.getByLabel('금액', { exact: true }).inputValue(), '18,500');
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []);
    results.push({ functional: 'edit/persist/quick-add/focus/clone/delete-cancel-confirm/undo/renewal-cancel-confirm/savings/search/reset/menu-Escape/sample-isolation', passed: true });
    await f.context.close();
    const failure = await fixture(1, 390);
    await failure.page.evaluate(key => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(k, value) {
        if (k === key) throw new DOMException('Synthetic storage quota failure', 'QuotaExceededError');
        return original.call(this, k, value);
      };
    }, storageKey);
    await failure.page.getByLabel('금액', { exact: true }).fill('19000');
    await failure.page.getByLabel('금액', { exact: true }).blur();
    await failure.page.getByRole('button', { name: '브라우저 저장 재시도', exact: true }).waitFor();
    assert.equal(await failure.page.getByRole('button', { name: '미저장 데이터 내보내기', exact: true }).isVisible(), true);
    assert.equal(await failure.page.locator('.header-save-error [role="alert"]').isVisible(), true);
    await failure.page.screenshot({ path: resolve(evidence, 'after-390-save-failure.png'), animations: 'disabled' });
    assert.deepEqual(failure.forbidden, []); assert.deepEqual(failure.errors, []);
    results.push({ unsavedFailureVisible: true, retryAndExportVisible: true });
    await failure.context.close();
  }
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify({ root, source: process.env.QUIET_EDITOR_SOURCE, before, results }, null, 2), { mode: 0o600 });
  console.log('PASS', evidence, JSON.stringify(results));
} finally { await browser.close(); await new Promise(r => server.close(r)); }
