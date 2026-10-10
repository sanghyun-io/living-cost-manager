// Local export + intercepted synthetic API only. Never forwards any remote request.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../out/', import.meta.url)));
const evidence = process.env.TOUR_EVIDENCE ?? '/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/product-tour-6112c268-evidence/tour';
await mkdir(evidence, { recursive: true, mode: 0o700 });
const server = createServer(async (req, res) => {
  try {
    let path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (path !== root && !path.startsWith(root + '/')) throw Error('outside export');
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png' }[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const apiOrigin = 'https://api.gamja.top';
const browser = await chromium.launch({ headless: true });
const states = new Map();
const writes = [], forbidden = [], errors = [], results = [];
const localBudget = { monthlyIncome: 1000, categories: [{ id: 'other', label: '기타' }], cards: [], fixedCosts: [] };
const cost = { id: 'synthetic-cost', name: '테스트 지출', categoryId: 'other', paymentMethodId: 'cash', paymentOptionId: '', amount: 100, periodMonths: 1, billingDay: 1, isEndOfMonth: false, billingAnchorDate: null };
async function fixture({ width = 390, scheme = 'light', account = null, viewer = false, empty = true, fail = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const user = { id: account, name: '테스트 사용자', email: 'tour@synthetic.invalid', emailVerified: false };
  const workspace = { id: 'one', name: '테스트 가계부', role: viewer ? 'viewer' : 'owner' };
  const control = { fail };
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    if (!account || url.origin !== apiOrigin || !url.pathname.startsWith('/living-cost-manager/v1/')) { forbidden.push(url.href); return route.abort(); }
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const path = url.pathname.slice('/living-cost-manager/v1'.length);
    let body;
    if (path === '/me') body = { user };
    else if (path === '/onboarding/product-tour') {
      if (req.method() === 'PUT') {
        const input = req.postDataJSON(); assert.deepEqual(Object.keys(input).sort(), ['status', 'version']); assert.equal(input.version, 1);
        writes.push({ account, path, input });
        if (states.get(account) !== 'completed') states.set(account, input.status);
      }
      if (control.fail) return route.fulfill({ status: 404, headers, body: '{}' });
      const status = states.get(account) ?? 'unseen';
      body = { version: 1, status, updatedAt: status === 'unseen' ? null : '2026-10-10T00:00:00.000Z' };
    } else if (path === '/workspaces') body = [workspace];
    else if (path === '/workspaces/one/snapshot') {
      assert.equal(req.method(), 'GET', 'Tour may never upload a snapshot');
      const budget = { ...localBudget, fixedCosts: empty ? [] : [cost] };
      body = { ...budget, workspaceId: 'one', syncVersion: 1, categories: budget.categories.map(row => ({ ...row, workspaceId: 'one' })), fixedCosts: budget.fixedCosts.map(row => ({ ...row, workspaceId: 'one' })) };
    } else if (path.endsWith('/history')) body = { entries: [] };
    else if (path.endsWith('/members') || path.includes('invitations') || path.includes('templates')) body = [];
    else { forbidden.push(path); return route.abort(); }
    return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ account, user, workspace, scheme, budget }) => {
    if (localStorage.getItem('tour-fixture')) return;
    localStorage.setItem('tour-fixture', '1'); localStorage.setItem('mantine-color-scheme-value', scheme);
    const id = account ? 'server:' + account : 'guest-tour';
    localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id, name: '테스트 사용자', ...(account ? { serverUserId: account } : {}) }]));
    localStorage.setItem('living-cost-manager:active-user:v1', id);
    localStorage.setItem('living-cost-manager:user:' + encodeURIComponent(id) + ':v1', JSON.stringify(budget));
    if (account) localStorage.setItem('living-cost-manager:server-session:v2', JSON.stringify({ token: 'synthetic-tour-' + account, refreshToken: 'synthetic-tour-refresh', user, workspace }));
  }, { account, user, workspace, scheme, budget: { ...localBudget, fixedCosts: empty ? [] : [cost] } });
  await page.goto(origin); await page.getByRole('button', { name: '도구', exact: true }).waitFor();
  return { page, context, control };
}
const invitation = page => page.getByRole('region', { name: '선택형 둘러보기' });
const tour = page => page.getByRole('dialog', { name: /항목 추가|납부일 확인|브라우저 저장과 백업|선택형/ });
async function replay(page) {
  await page.getByRole('button', { name: '도구', exact: true }).click();
  await page.getByRole('menuitem', { name: '둘러보기', exact: true }).click();
  await tour(page).waitFor();
}
async function bounds(page, name) {
  await page.waitForFunction(() => {
    const card = document.querySelector('.product-tour-card');
    if (!card) return false;
    const r = card.getBoundingClientRect(), v = visualViewport;
    return r.left >= (v?.offsetLeft ?? 0) - 1 && r.top >= (v?.offsetTop ?? 0) - 1 && r.right <= (v?.offsetLeft ?? 0) + (v?.width ?? innerWidth) + 1 && r.bottom <= (v?.offsetTop ?? 0) + (v?.height ?? innerHeight) + 1;
  });
  const clipping = await page.locator('.product-tour-card').evaluate(card => {
    const r = card.getBoundingClientRect(), v = visualViewport;
    return Math.max(0, (v?.offsetLeft ?? 0) - r.left, (v?.offsetTop ?? 0) - r.top, r.right - ((v?.offsetLeft ?? 0) + (v?.width ?? innerWidth)), r.bottom - ((v?.offsetTop ?? 0) + (v?.height ?? innerHeight)));
  });
  assert.ok(clipping <= 1, name + ': card clipping ' + clipping);
  assert.equal(await page.locator('.product-tour-card button').evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().height >= 44)), true);
  await page.screenshot({ path: resolve(evidence, name + '.png'), animations: 'disabled' });
  return clipping;
}
try {
  for (const width of [320, 390, 768, 1440]) for (const scheme of ['light', 'dark']) for (const textScale of [1, 2]) {
    const f = await fixture({ width, scheme }), { page } = f;
    await invitation(page).waitFor(); assert.equal(await tour(page).count(), 0);
    const before = await page.locator('.cost-list').evaluate(node => node.getBoundingClientRect().top + scrollY);
    await invitation(page).getByRole('button', { name: '시작' }).click();
    await tour(page).waitFor();
    if (textScale === 2) await page.evaluate(() => {
      // Same computed-text 200% fixture as the retained quiet-editor suite.
      const sizes = Array.from(document.querySelectorAll('body *')).filter(node => node instanceof HTMLElement).map(node => [node, parseFloat(getComputedStyle(node).fontSize)]);
      for (const [node, size] of sizes) node.style.fontSize = `${size * 2}px`;
    });
    for (let step = 0; step < 4; step++) {
      await tour(page).waitFor();
      const name = `${width}-${scheme}-${textScale * 100}text-step${step + 1}`;
      const clipping = await bounds(page, name);
      results.push({ width, scheme, textScale, step: step + 1, clipping });
      assert.equal(await page.locator('.table-row:not(.table-head)').count(), 0, 'Tour must not create an item');
      assert.equal(await tour(page).getAttribute('aria-modal'), 'false');
      await tour(page).getByRole('button', { name: step === 3 ? '완료' : '다음', exact: true }).click();
    }
    assert.equal(await invitation(page).count(), 0);
    if (textScale === 1) assert.equal(await page.locator('.cost-list').evaluate(node => node.getBoundingClientRect().top + scrollY), before);
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-product-tour-opener'));
    assert.equal(await page.getByRole('button', { name: '도구', exact: true }).evaluate(node => document.activeElement === node), true, 'safe opener focus restore');
    await page.reload(); assert.equal(await invitation(page).count(), 0); await f.context.close();
  }
  // Chromium pinch/page zoom exercises visualViewport at 200%, not just text scaling.
  for (const width of [320, 390, 768, 1440]) for (const scheme of ['light', 'dark']) {
    const f = await fixture({ width, scheme });
    const cdp = await f.context.newCDPSession(f.page);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await invitation(f.page).getByRole('button', { name: '시작' }).click(); await tour(f.page).waitFor();
    for (let step = 0; step < 4; step++) {
      const clipping = await bounds(f.page, `${width}-${scheme}-200viewport-step${step + 1}`);
      results.push({ width, scheme, pageZoom: 2, step: step + 1, clipping });
      const button = tour(f.page).getByRole('button', { name: step === 3 ? '완료' : '다음', exact: true });
      // Explicit native keyboard activation at pinch zoom (normal matrix tests pointer clicks).
      await button.focus(); await button.press('Enter');
      if (step < 3) await tour(f.page).getByText(new RegExp(`${step + 2} \\/ 4`)).waitFor();
    }
    await f.context.close();
  }
  const contrast = await fixture({ width: 320 });
  await contrast.page.emulateMedia({ forcedColors: 'active' });
  await invitation(contrast.page).getByRole('button', { name: '시작' }).click();
  for (let step = 0; step < 4; step++) {
    const clipping = await bounds(contrast.page, `320-forced-colors-step${step + 1}`);
    results.push({ width: 320, forcedColors: true, step: step + 1, clipping });
    await tour(contrast.page).getByRole('button', { name: step === 3 ? '완료' : '다음', exact: true }).click();
  }
  await contrast.context.close();
  // Existing help relation survives tour annotation, while keyboard remains nontrapped.
  const f = await fixture({ empty: false }), p = f.page;
  await invitation(p).getByRole('button', { name: '시작' }).click();
  const date = p.getByLabel('테스트 지출 기준 납부일'); const originalHelp = await date.getAttribute('aria-describedby');
  await tour(p).getByRole('button', { name: '다음', exact: true }).click();
  assert.ok((await date.getAttribute('aria-describedby')).includes(originalHelp));
  await date.focus(); assert.equal(await date.evaluate(node => document.activeElement === node), true);
  await p.keyboard.press('Tab'); assert.equal(await p.evaluate(() => !!document.activeElement?.closest('.product-tour-card')), false, 'Tab outside card is not trapped');
  await date.focus();
  await date.press('Escape'); assert.equal(await tour(p).count(), 0); assert.equal(await date.getAttribute('aria-describedby'), originalHelp);
  await replay(p);
  await p.locator('[data-product-tour="data"]').click();
  await p.getByRole('button', { name: '데이터 관리 닫기' }).waitFor(); assert.equal(await tour(p).count(), 0);
  await p.keyboard.press('Escape'); await tour(p).waitFor();
  assert.equal(await tour(p).getByText(/1 \/ 4/).count(), 1, 'modal Escape must not terminate tour');
  // Remove every whitelist target while tour remains mounted: next/back/close remain usable.
  await p.evaluate(() => document.querySelectorAll('[data-product-tour]').forEach(node => node.removeAttribute('data-product-tour')));
  await tour(p).getByRole('button', { name: '다음', exact: true }).click(); await tour(p).getByRole('button', { name: '이전', exact: true }).click();
  await tour(p).getByRole('button', { name: '둘러보기 닫기' }).click(); await f.context.close();
  // Complete on unverified viewer account A; a new browser/profile sees terminal state.
  const viewer = await fixture({ account: 'account-a', viewer: true });
  await invitation(viewer.page).getByRole('button', { name: '시작' }).click();
  assert.ok((await tour(viewer.page).textContent()).includes('보기 전용'));
  for (let i = 0; i < 3; i++) await tour(viewer.page).getByRole('button', { name: '다음', exact: true }).click();
  await tour(viewer.page).getByRole('button', { name: '완료', exact: true }).click();
  await viewer.page.waitForFunction(() => JSON.parse(localStorage.getItem('living-cost-manager:product-tour:v1:account%3Aaccount-a'))?.pending === false);
  assert.equal(states.get('account-a'), 'completed'); await viewer.context.close();
  const otherBrowser = await fixture({ account: 'account-a' });
  await otherBrowser.page.waitForFunction(() => JSON.parse(localStorage.getItem('living-cost-manager:product-tour:v1:account%3Aaccount-a'))?.status === 'completed');
  assert.equal(await invitation(otherBrowser.page).count(), 0);
  const priorWrites = writes.length; await replay(otherBrowser.page); await otherBrowser.page.keyboard.press('Escape'); assert.equal(writes.length, priorWrites); await otherBrowser.context.close();
  const otherAccount = await fixture({ account: 'account-b' }); await invitation(otherAccount.page).waitFor();
  await invitation(otherAccount.page).getByRole('button', { name: '건너뛰기' }).click();
  await otherAccount.page.waitForFunction(() => JSON.parse(localStorage.getItem('living-cost-manager:product-tour:v1:account%3Aaccount-b'))?.pending === false);
  assert.equal(states.get('account-b'), 'skipped'); await otherAccount.context.close();
  const failed = await fixture({ account: 'failed-account', fail: true });
  await failed.page.waitForTimeout(150); assert.equal(await invitation(failed.page).count(), 0);
  await replay(failed.page); await failed.page.keyboard.press('Escape');
  assert.equal(writes.filter(w => w.account === 'failed-account').length, 0);
  failed.control.fail = false; await failed.page.reload();
  await failed.page.waitForFunction(() => JSON.parse(localStorage.getItem('living-cost-manager:product-tour:v1:account%3Afailed-account'))?.pending === false);
  assert.equal(states.get('failed-account'), 'skipped'); await failed.context.close();
  // Sample exploration stays isolated and never flushes a real account's queue.
  const sample = await fixture(); await invitation(sample.page).getByRole('button', { name: '건너뛰기' }).click();
  await sample.page.locator('.workspace-tools > summary').click(); await sample.page.getByRole('button', { name: '분리된 샘플 체험' }).click();
  await sample.page.getByText('샘플 체험 중 · 내 데이터와 분리된 예시입니다.', { exact: true }).waitFor();
  assert.equal(await invitation(sample.page).count(), 0); const sampleWrites = writes.length;
  await replay(sample.page); await sample.page.keyboard.press('Escape'); assert.equal(writes.length, sampleWrites); await sample.context.close();
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []); assert.equal(writes.filter(w => w.path.includes('snapshot')).length, 0);
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify({ results, cases: ['keyboard/no-trap/opener-focus', 'Escape/help-restoration', 'modal-pause/Escape-priority', 'missing-target/back/close', 'viewer/unverified', 'cross-profile-completed', 'other-account-independent', 'replay-close-no-regression', '404/manual/resume', 'sample-no-PUT'], tourWrites: writes, snapshotPuts: 0, forwardedRemoteRequests: 0, errors, forbidden }, null, 2), { mode: 0o600 });
  console.log('PASS', evidence, results.length, 'spotlight screenshots, clipping=0, snapshot PUT=0, forwarded remote=0');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
