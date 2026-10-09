// Local static export only; synthetic sessions and API responses. No real API/SDK requests.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';

const root = resolve(fileURLToPath(new URL('../out/', import.meta.url)));
const server = createServer(async (req, res) => {
  try {
    let path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (path !== root && !path.startsWith(root + '/')) throw Error('outside export');
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    const body = await readFile(path);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
    res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404, { 'content-type': 'text/html' }); res.end(await readFile(resolve(root, '404.html'))); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const user = { id: 'free-fixture', name: 'Synthetic', email: 'free@synthetic.invalid', emailVerified: true };
const ledger = (id, role = 'owner') => ({ id, name: `가계부 ${id}`, role });
const localSnapshot = amount => ({ monthlyIncome: 5000, categories: [{ id: 'other', label: '기타' }], cards: [], fixedCosts: [{ id: 'cost', name: '무료 고정비', categoryId: 'other', paymentMethodId: 'cash', paymentOptionId: '', amount, periodMonths: 1, billingDay: 1, isEndOfMonth: false, billingAnchorDate: null }] });
const profile = id => 'ledger:' + JSON.stringify([user.id, id]);
const key = id => 'living-cost-manager:user:' + encodeURIComponent(id) + ':v1';
const browser = await chromium.launch({ headless: true });
async function fixture(initial, selected, viewport = { width: 390, height: 844 }, failList = false) {
  const workspaces = [...initial], posts = [], forbidden = [], errors = [];
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin) { await route.continue(); return; }
    if (url.origin !== 'https://api.gamja.top') { forbidden.push(url.origin); await route.abort(); return; }
    const path = url.pathname.replace('/living-cost-manager/v1', '');
    if (path.includes('aggregate') || path.includes('billing') || path.includes('subscription')) { forbidden.push(path); await route.abort(); return; }
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS', 'access-control-allow-headers': '*' } }); return; }
    let body;
    if (path === '/me') body = { user };
    else if (path === '/workspaces' && req.method() === 'GET') {
      if (failList) { await route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: '{}' }); return; }
      body = workspaces;
    } else if (path === '/workspaces' && req.method() === 'POST') {
      const input = req.postDataJSON(); posts.push(input);
      const workspace = ledger('created'); workspaces.push(workspace);
      body = { workspace, snapshot: { ...input.initialBudget, workspaceId: workspace.id, syncVersion: 0 } };
    } else if (/\/snapshot$/.test(path)) {
      const id = path.split('/')[2], budget = localSnapshot(id === 'two' ? 200 : 100);
      body = { ...budget, workspaceId: id, syncVersion: 1, categories: budget.categories.map(row => ({ ...row, workspaceId: id })), fixedCosts: budget.fixedCosts.map(row => ({ ...row, workspaceId: id })) };
    } else if (/\/snapshot\/history$/.test(path)) body = { entries: [] };
    else if (/\/members$/.test(path)) body = [{ id: 'member', workspaceId: path.split('/')[2], userId: user.id, name: user.name, email: user.email, role: workspaces.find(w => w.id === path.split('/')[2])?.role ?? 'owner' }];
    else if (path.includes('invitations') || path.includes('templates')) body = [];
    else if (path === '/auth/logout') body = {};
    else { forbidden.push(path); await route.abort(); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  if (selected !== undefined) await page.addInitScript(({ user, selected, original, second, keyOne, keyTwo }) => {
    if (localStorage.getItem('free-fixture-seeded')) return;
    localStorage.setItem('free-fixture-seeded', '1');
    localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id: 'server:' + user.id, name: user.name, serverUserId: user.id }]));
    localStorage.setItem('living-cost-manager:active-user:v1', 'server:' + user.id);
    localStorage.setItem('living-cost-manager:server-session:v2', JSON.stringify({ token: 'synthetic-free-session', refreshToken: 'synthetic-free-refresh', user, workspace: selected }));
    localStorage.setItem(keyOne, JSON.stringify(original)); localStorage.setItem(keyTwo, JSON.stringify(second));
  }, { user, selected, original: localSnapshot(100), second: localSnapshot(200), keyOne: key('server:' + user.id), keyTwo: key(profile('two')) });
  await page.goto(origin); await page.getByRole('button', { name: '도구', exact: true }).waitFor();
  return { page, context, posts, forbidden, errors };
}
async function templateFields(page) {
  await page.getByRole('button', { name: '도구', exact: true }).click();
  await page.getByRole('menuitem', { name: '템플릿', exact: true }).click();
  const fields = page.getByRole('region', { name: '새 공간에 템플릿 적용' }).locator('input');
  await fields.first().waitFor(); // Wait for the asynchronous template panel before counting/filling fields.
  for (let i = 0; i < await fields.count(); i++) await fields.nth(i).fill(i === 0 ? '1000' : '100');
  return page.getByRole('button', { name: '금액 확인 후 새 공간 만들기' });
}
async function noPaidControls(page) {
  assert.equal(await page.getByRole('checkbox', { name: '합산 보기', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '선택한 가계부 합산 조회' }).count(), 0);
  assert.equal(await page.locator('a[href^="/subscription"]').count(), 0);
  assert.equal(await page.locator('script[src*="portone"]').count(), 0);
}
try {
  async function inspectExport(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await inspectExport(path);
      else if (/\.(html|js|txt)$/.test(entry.name)) {
        const text = await readFile(path, 'utf8');
        assert.doesNotMatch(text, /990원|9,900원|구독 관리 · 결제 준비|이용 요금 · 유료|cdn\.portone|requestIssueBillingKey|선택한 가계부 합산 조회|합산 보기/, 'paid surface present in exported ' + entry.name);
      }
    }
  }
  await inspectExport(root);
  assert.equal((await fetch(origin + '/subscription/')).status, 404);
  assert.equal((await fetch(origin + '/features/service-subscription/')).status, 404);
  for (const path of ['/guide/', '/guide/templates/', '/guide/backup-and-sync/', '/guide/faq/', '/sitemap.xml']) {
    const response = await fetch(origin + path); assert.equal(response.status, 200);
    const html = await response.text(); assert.doesNotMatch(html, /\/subscription\/|가격안|유료 요금|가계부 선택·합산/);
    if (path === '/guide/faq/') assert.match(html, /FAQPage/);
    if (path === '/guide/templates/') assert.match(html, /Article/);
  }
  const guest = await fixture([], undefined);
  const applyGuest = await templateFields(guest.page); assert.equal(await applyGuest.isEnabled(), true);
  await applyGuest.click(); await guest.page.getByLabel('금액', { exact: true }).first().waitFor();
  assert.equal(guest.posts.length, 0); await noPaidControls(guest.page);
  assert.equal(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(guest.errors, []); assert.deepEqual(guest.forbidden, []); await guest.context.close();

  for (const initial of [[ledger('one')], [ledger('one'), ledger('two'), ledger('view', 'viewer')]]) {
    const f = await fixture(initial, initial[0]); const { page } = f;
    await page.getByRole('button', { name: '가계부 목록 새로고침' }).click();
    await page.getByText('가계부 목록을 확인했습니다.', { exact: true }).waitFor();
    await noPaidControls(page); assert.equal(await page.getByRole('button', { name: '새 가계부', exact: true }).count(), 0);
    const apply = await templateFields(page); assert.equal(await apply.isDisabled(), true);
    await page.getByText('현재 무료판에서는 새 가계부 추가를 제공하지 않습니다.', { exact: false }).waitFor();
    await page.getByRole('button', { name: '생활비 템플릿 닫기' }).click();
    const amount = page.getByLabel('금액', { exact: true }).first(); await amount.fill('111'); await amount.blur();
    await page.locator('.workspace-tools > summary').click();
    await page.getByRole('button', { name: '분리된 샘플 체험', exact: true }).click();
    const returnButton = page.getByRole('button', { name: '내 데이터로 시작 / 돌아가기', exact: true });
    await returnButton.waitFor(); await returnButton.focus(); await returnButton.press('Enter');
    await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '111');
    assert.equal(await page.getByRole('button', { name: '분리된 샘플 체험', exact: true }).evaluate(node => node === document.activeElement), true);
    if (initial.length > 1) {
      await page.getByLabel('현재 가계부', { exact: true }).selectOption('two');
      await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '200');
      await page.getByLabel('현재 가계부', { exact: true }).selectOption('one');
      await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '111');
      await page.getByLabel('현재 가계부', { exact: true }).selectOption('view');
      await page.getByText('보기 전용 가계부입니다.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: '항목 추가', exact: true }).isDisabled(), true);
    }
    assert.equal(f.posts.length, 0); assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await f.context.close();
  }
  const first = await fixture([], null);
  await first.page.getByRole('button', { name: '가계부 목록 새로고침' }).click();
  await first.page.getByText('가계부 목록을 확인했습니다.', { exact: true }).waitFor();
  await first.page.getByRole('button', { name: '새 가계부', exact: true }).click();
  const name = first.page.getByLabel(/새 가계부 이름/); await name.fill('첫 가계부'); await name.press('Enter');
  await first.page.getByText('새 가계부를 만들었습니다.', { exact: false }).waitFor();
  await first.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '현재 가계부');
  assert.equal(first.posts.length, 1); assert.equal(first.posts[0].initialBudget.fixedCosts.length, 0);
  await first.context.close();

  for (const initial of [[], [ledger('shared', 'viewer')]]) {
    const f = await fixture(initial, initial[0] ?? null, { width: 1280, height: 900 });
    await f.page.getByRole('button', { name: '가계부 목록 새로고침' }).click();
    await f.page.getByText('가계부 목록을 확인했습니다.', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: '새 가계부', exact: true }).isEnabled(), true);
    const apply = await templateFields(f.page);
    await f.page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '금액 확인 후 새 공간 만들기' && !button.disabled));
    assert.equal(await apply.isEnabled(), true); await apply.click();
    await f.page.getByText('새 가계부를 만들었습니다.', { exact: false }).waitFor();
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0].initialBudget.monthlyIncome, 1000);
    assert.ok(f.posts[0].initialBudget.fixedCosts.every(cost => cost.amount === 100));
    assert.equal(await f.page.getByRole('button', { name: '새 가계부', exact: true }).count(), 0);
    await noPaidControls(f.page); assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, []); await f.context.close();
  }
  const unavailable = await fixture([], null, undefined, true);
  assert.equal(await unavailable.page.getByRole('button', { name: '새 가계부', exact: true }).count(), 0);
  assert.equal(await (await templateFields(unavailable.page)).isDisabled(), true);
  await unavailable.page.getByText('가계부 목록을 확인한 뒤 첫 가계부를 만들 수 있습니다.', { exact: false }).waitFor();
  assert.equal(unavailable.posts.length, 0); await unavailable.context.close();
  console.log('PASS free-only static routes 404; guest local template; OWN0 ordinary first creation/focus and shared-viewer first template; OWN1/multiple preserved edit/cache/sample-return-focus/viewer access; no extra-create/aggregate/billing/SDK calls; unknown list fail-closed; mobile overflow');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
