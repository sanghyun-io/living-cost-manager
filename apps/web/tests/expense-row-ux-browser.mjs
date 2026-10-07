// Synthetic local profiles only. Every non-export request is blocked.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile, readdir, chmod } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root = resolve(process.env.ROW_UX_EXPORT ?? fileURLToPath(new URL('../out/', import.meta.url)));
const before = process.env.ROW_UX_BEFORE === '1';
const apiBase = process.env.ROW_UX_API_BASE ?? 'https://api.gamja.top/living-cost-manager/v1';
const apiUrl = new URL(apiBase);
const evidence = resolve(process.env.ROW_UX_EVIDENCE ?? `/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/expense-row-evidence-${randomUUID()}`);
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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const storageKey = 'living-cost-manager:user:guest-row-fixture:v1';
const costs = count => Array.from({ length: count }, (_, i) => ({
  id: `synthetic-cost-${i}`, name: `테스트 지출 ${i + 1}`, categoryId: 'other', paymentMethodId: 'bank-transfer',
  paymentOptionId: 'auto-transfer', amount: 12000 + i, periodMonths: 1, billingDay: 17,
  isEndOfMonth: false, billingAnchorDate: null, renewalStatus: 'unreviewed', potentialMonthlySavings: 0, confirmedMonthlySavings: 0
}));
const browser = await chromium.launch({ headless: true });
const results = [];
async function fixture(count, viewport, serverLedger = false) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const forbidden = [], errors = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (serverLedger && url.origin === apiUrl.origin && url.pathname.startsWith(apiUrl.pathname + '/')) {
      // Fulfill synthetic responses in-process, never forward to the configured origin.
      const path = url.pathname.slice(apiUrl.pathname.length);
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const user = { id: 'row-server-fixture', name: '테스트 사용자', email: 'row@synthetic.invalid', emailVerified: true };
      let body;
      if (path === '/me') body = { user };
      else if (path === '/workspaces') body = ['one', 'two'].map(id => ({ id, name: `테스트 공간 ${id}`, role: 'owner' }));
      else if (/\/snapshot$/.test(path)) {
        const id = path.split('/')[2];
        body = { workspaceId: id, syncVersion: 1, monthlyIncome: 3000000, categories: [{ id: 'other', label: '기타', workspaceId: id }], cards: [], fixedCosts: (id === 'one' ? costs(count) : [{ ...costs(1)[0], name: '다른 공간 지출' }]).map(row => ({ ...row, workspaceId: id })) };
      } else if (/\/members$/.test(path)) body = [];
      else if (/\/snapshot\/history$/.test(path)) body = { entries: [] };
      if (body !== undefined) return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
    }
    forbidden.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ storageKey, fixedCosts, serverLedger }) => {
    if (localStorage.getItem('row-seeded')) return;
    localStorage.setItem('row-seeded', '1');
    localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id: 'guest-row-fixture', name: '테스트 사용자' }]));
    localStorage.setItem('living-cost-manager:active-user:v1', 'guest-row-fixture');
    localStorage.setItem(storageKey, JSON.stringify({ monthlyIncome: 3000000, categories: [{ id: 'other', label: '기타' }], cards: [], fixedCosts }));
    if (serverLedger) {
      const user = { id: 'row-server-fixture', name: '테스트 사용자', email: 'row@synthetic.invalid', emailVerified: true };
      localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id: 'server:' + user.id, name: user.name, serverUserId: user.id }]));
      localStorage.setItem('living-cost-manager:active-user:v1', 'server:' + user.id);
      localStorage.setItem('living-cost-manager:server-session:v2', JSON.stringify({ token: 'synthetic-row-token', refreshToken: 'synthetic-row-refresh', user, workspace: { id: 'one', name: '테스트 공간 one', role: 'owner' } }));
      localStorage.setItem('living-cost-manager:user:' + encodeURIComponent('server:' + user.id) + ':v1', localStorage.getItem(storageKey));
    }
  }, { storageKey, fixedCosts: costs(count), serverLedger });
  await page.goto(origin);
  await page.waitForFunction(count => document.querySelectorAll('.table-row:not(.table-head)').length === count, count);
  return { page, context, forbidden, errors };
}
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 900 }]) {
    const f = await fixture(30, viewport), { page } = f;
    const first = page.getByRole('group', { name: '테스트 지출 1', exact: true });
    await page.locator('.cost-list').evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top));
    await page.screenshot({ path: resolve(evidence, `${before ? 'before' : 'after'}-${viewport.width}.png`), animations: 'disabled' });
    if (viewport.width < 600) {
      await first.evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - 16));
      await page.screenshot({ path: resolve(evidence, `${before ? 'before' : 'after'}-${viewport.width}-first-row.png`), animations: 'disabled' });
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const height = await first.evaluate(node => node.getBoundingClientRect().height);
    if (before) {
      assert.equal(await page.getByText('다음 납부일 미확인: 실제 청구 기준 납부일을 입력하세요. 카드 결제일과는 별개입니다.', { exact: true }).count(), 30);
      assert.equal(await first.getByRole('button', { name: '테스트 지출 1 복제', exact: true }).count(), 1);
    } else {
      assert.equal(await page.getByText(/납부일은 실제 청구 기준이며 카드 결제일과 별개입니다/).count(), 1);
      assert.equal(await page.getByText('납부일 미입력', { exact: true }).count(), 30);
      assert.equal(await page.getByText(/다음 납부일 미확인:/).count(), 0);
      const date = first.getByLabel('테스트 지출 1 기준 납부일');
      assert.equal(await date.evaluate(input => document.getElementById(input.getAttribute('aria-describedby'))?.textContent.includes('카드 결제일과 별개')), true);
      await date.fill('2026-10-17'); await date.blur();
      const more = first.getByRole('button', { name: '테스트 지출 1 더보기', exact: true });
      const clone = page.getByRole('menuitem', { name: '테스트 지출 1 복제', exact: true });
      assert.equal(await clone.count(), 0);
      await more.focus(); await more.press('Enter'); await clone.waitFor();
      await page.screenshot({ path: resolve(evidence, `after-${viewport.width}-menu.png`), animations: 'disabled' });
      assert.equal(await more.getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('ArrowDown');
      assert.equal(await clone.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Escape'); await clone.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '테스트 지출 1 더보기');
      await more.press('Space'); await clone.waitFor();
      await page.keyboard.press('Tab'); await clone.waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('group', { name: '테스트 지출 2', exact: true }).getByLabel('항목명', { exact: true }).evaluate(node => node === document.activeElement), true);
      await more.focus(); await more.press('Enter'); await clone.waitFor(); await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Shift+Tab'); await clone.waitFor({ state: 'hidden' });
      assert.equal(await first.getByLabel('갱신 검토', { exact: true }).evaluate(node => node === document.activeElement), true);
      await more.click(); await clone.waitFor();
      await first.evaluate(node => { node.closest('fieldset').disabled = true; });
      assert.equal(await clone.isDisabled(), true);
      await first.evaluate(node => { node.closest('fieldset').disabled = false; });
      await page.getByRole('heading', { name: '고정비 항목', exact: true }).click();
      await clone.waitFor({ state: 'hidden' });
      await more.focus(); await more.press('Enter'); await clone.waitFor(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      const copied = page.getByRole('group', { name: '테스트 지출 1 (복사)', exact: true });
      await copied.waitFor();
      await page.waitForFunction(() => document.activeElement?.value === '테스트 지출 1 (복사)');
      const snapshot = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
      assert.equal(snapshot.fixedCosts.length, 31);
      assert.equal(new Set(snapshot.fixedCosts.map(row => row.id)).size, 31);
      const { id, name, ...fields } = snapshot.fixedCosts.at(-1);
      assert.deepEqual(fields, Object.fromEntries(Object.entries(snapshot.fixedCosts[0]).filter(([key]) => !['id', 'name'].includes(key))));
      assert.equal(fields.billingAnchorDate, '2026-10-17');
      await page.reload(); await copied.waitFor();
      await page.getByRole('button', { name: '삭제 모드', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: /더보기$/ }).count(), 0);
      await copied.getByRole('checkbox', { name: '삭제 선택', exact: true }).check();
      page.once('dialog', dialog => dialog.dismiss());
      await page.getByRole('button', { name: '선택 삭제', exact: true }).click(); assert.equal(await copied.count(), 1);
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: '선택 삭제', exact: true }).click(); await copied.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '테스트 지출 1 더보기', exact: true }).click(); await clone.waitFor();
      await page.getByRole('button', { name: '분리된 샘플 체험', exact: true }).click(); await clone.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '내 데이터로 시작 / 돌아가기', exact: true }).click(); await first.waitFor();
      assert.equal(await page.getByRole('menu').count(), 0);
      assert.equal(await first.getByLabel('테스트 지출 1 기준 납부일').inputValue(), '2026-10-17');
    }
    assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, []);
    results.push({ viewport, firstRowHeight: height, forbiddenRequests: 0, pageErrors: 0 });
    await f.context.close();
  }
  if (!before) {
    const f = await fixture(3, { width: 375, height: 900 }, true), { page } = f;
    await page.getByRole('button', { name: '가계부 목록 새로고침' }).click();
    await page.getByText('가계부 목록을 확인했습니다.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '테스트 지출 1 더보기', exact: true }).click();
    await page.getByRole('menuitem', { name: '테스트 지출 1 복제', exact: true }).waitFor();
    await page.getByLabel('현재 가계부', { exact: true }).selectOption('two');
    await page.getByRole('group', { name: '다른 공간 지출', exact: true }).waitFor();
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.equal(await page.locator('.table-row:not(.table-head)').count(), 1);
    await page.getByLabel('현재 가계부', { exact: true }).selectOption('one');
    await page.getByRole('group', { name: '테스트 지출 1', exact: true }).waitFor();
    assert.equal(await page.locator('.table-row:not(.table-head)').count(), 3);
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, []);
    results.push({ syntheticWorkspaceSwitch: 'one → two → one', forbiddenRequests: 0, pageErrors: 0 });
    await f.context.close();
  }
  const buildId = (await readFile(resolve(root, '../.next/BUILD_ID'), 'utf8')).trim();
  const exportIndexSha256 = createHash('sha256').update(await readFile(resolve(root, 'index.html'))).digest('hex');
   await writeFile(resolve(evidence, `${before ? 'before' : 'after'}-results.json`), JSON.stringify({ root, source: process.env.ROW_UX_SOURCE, buildId, exportIndexSha256, apiBase, before, results }, null, 2), { mode: 0o600 });
  for (const file of await readdir(evidence)) await chmod(resolve(evidence, file), 0o600);
  console.log('PASS', before ? 'baseline synthetic screenshots' : '30-row desktop/mobile; single guidance; date labels; menu Enter/Space/ArrowDown/Escape/Tab/ShiftTab/outside; clone once/new ID/data/focus/cache; delete cancel/confirm; profile-switch menu cleanup; no remote requests', evidence);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
