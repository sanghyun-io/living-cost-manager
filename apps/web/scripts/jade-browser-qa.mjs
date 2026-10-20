// Isolated synthetic headless Chromium only. All non-local traffic is blocked.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../out/', import.meta.url)));
const evidence = process.env.JADE_QA_EVIDENCE;
if (!evidence) throw Error('Set JADE_QA_EVIDENCE to an owned output directory');
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    let path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (path !== root && !path.startsWith(root + '/')) throw Error('outside export');
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' }[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      if (localStorage.getItem('jade-fixture')) return;
      localStorage.setItem('jade-fixture', '1');
      localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id: 'jade-synthetic', name: '합성 QA 사용자' }]));
      localStorage.setItem('living-cost-manager:active-user:v1', 'jade-synthetic');
      localStorage.setItem('living-cost-manager:product-tour:v1:' + encodeURIComponent('local:jade-synthetic'), JSON.stringify({ version: 1, status: 'completed', pending: false }));
      localStorage.setItem('living-cost-manager:user:jade-synthetic:v1', JSON.stringify({ monthlyIncome: 3000000, categories: [{ id: 'other', label: '기타' }], cards: [], fixedCosts: [{ id: 'rent', name: '합성 주거비', amount: 500000, categoryId: 'other', paymentMethodId: 'bank-transfer', paymentOptionId: 'auto-transfer', periodMonths: 1, billingDay: 25, isEndOfMonth: false, billingAnchorDate: '2026-10-25', renewalStatus: 'unreviewed', potentialMonthlySavings: 0, confirmedMonthlySavings: 0 }] }));
    });
    await page.goto(origin);
    try { await page.locator('#view-heading').waitFor(); } catch (e) { console.log({ errors, text: await page.locator('body').innerText() }); throw e; }
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('heading', { name: '이번 주를 가볍게' }).waitFor();
    await page.screenshot({ path: resolve(evidence, `home-${width}.png`), fullPage: true });
    const nav = page.getByRole('navigation', { name: width > 900 ? '작업 메뉴' : '모바일 작업 메뉴', exact: true });
    await nav.getByRole('button', { name: '항목', exact: true }).click();
    await page.getByRole('region', { name: '고정비 편집', exact: true }).waitFor();
    assert.equal(await page.locator('#fixed-costs').isVisible(), true);
    await page.screenshot({ path: resolve(evidence, `items-${width}.png`), fullPage: true });
    await nav.getByRole('button', { name: '계획', exact: true }).click();
    assert.equal(await page.locator('.weekly-budget-panel').isVisible(), true);
    await nav.getByRole('button', { name: '검토', exact: true }).click();
    await page.locator('.month-review > summary').click();
    assert.equal(await page.locator('.month-review-record').isVisible(), true);
    await page.locator('.app-header').getByRole('button', { name: '설정', exact: true }).click();
    for (const [id, label] of [['jade', '제이드'], ['aqua', '아쿠아'], ['violet', '바이올렛'], ['raspberry', '라즈베리'], ['tangerine', '탠저린']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await page.locator('html').getAttribute('data-lcm-theme'), id);
      assert.equal(await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true');
      for (const mode of ['light', 'dark']) {
        const desired = mode === 'dark' ? '어둡게 보기' : '밝게 보기';
        const button = page.getByRole('button', { name: desired, exact: true });
        if (await button.count()) await button.click();
        assert.equal(await page.locator('html').getAttribute('data-mantine-color-scheme'), mode);
        assert.equal(await page.locator('html').getAttribute('data-lcm-theme'), id);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false, `${width}/${id}/${mode} overflow`);
        if (width === 390 || id === 'jade') await page.screenshot({ path: resolve(evidence, `settings-${width}-${id}-${mode}.png`), fullPage: true });
      }
    }
    await page.reload(); await page.locator('#view-heading').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-lcm-theme'), 'tangerine');
    assert.deepEqual(errors, []);
    results.push({ width, themes: 5, modes: 2, navigation: 'home/items/plan/review/settings', reload: 'tangerine', pageErrors: errors });
    await context.close();
  }
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); await new Promise(r => server.close(r)); }
