// Run directly with node, after an existing static export; never builds/downloads.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../out/', import.meta.url)));
const evidence = process.env.THEME_ADVERSARIAL_EVIDENCE;
if (!evidence) throw Error('Owned evidence directory required');
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
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.THEME_CHROMIUM_EXECUTABLE });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, serviceWorkers: 'block' });
    try {
      const external = [], errors = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(new URL(route.request().url()).origin); return route.abort();
      });
      await context.addInitScript(() => {
        if (localStorage.getItem('independent-theme-fixture')) return;
        localStorage.setItem('independent-theme-fixture', '1');
        localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id: 'synthetic-local-A', name: 'Independent synthetic A', uiTheme: 'violet' }, { id: 'synthetic-local-B', name: 'Independent synthetic B', uiTheme: 'aqua' }]));
        localStorage.setItem('living-cost-manager:active-user:v1', 'synthetic-local-A');
        for (const id of ['synthetic-local-A', 'synthetic-local-B']) {
          localStorage.setItem(`living-cost-manager:product-tour:v1:${encodeURIComponent('local:' + id)}`, JSON.stringify({ version: 1, status: 'completed', pending: false }));
          localStorage.setItem(`living-cost-manager:user:${id}:v1`, JSON.stringify({ monthlyIncome: 0, categories: [], cards: [], fixedCosts: [] }));
        }
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin); await page.locator('#view-heading').waitFor();
      await page.waitForFunction(() => document.documentElement.dataset.lcmTheme === 'violet');
      await page.locator('.app-header').getByRole('button', { name: '설정', exact: true }).click();
      const before = await page.evaluate(() => localStorage.getItem('living-cost-manager:user:synthetic-local-A:v1'));
      for (const [id, label] of [['jade', '제이드'], ['aqua', '아쿠아'], ['violet', '바이올렛'], ['raspberry', '라즈베리'], ['tangerine', '탠저린']]) {
        await page.getByRole('button', { name: label, exact: true }).click();
        for (const mode of ['light', 'dark']) {
          const toggle = page.getByRole('button', { name: mode === 'dark' ? '어둡게 보기' : '밝게 보기', exact: true });
          if (await toggle.count()) await toggle.click();
          assert.equal(await page.locator('html').getAttribute('data-lcm-theme'), id);
          assert.equal(await page.locator('html').getAttribute('data-mantine-color-scheme'), mode);
          assert.equal(await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
      }
      await page.screenshot({ path: resolve(evidence, `independent-settings-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => localStorage.getItem('living-cost-manager:user:synthetic-local-A:v1')), before);
      const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem('living-cost-manager:users:v1')));
      assert.equal(profiles.find(u => u.id === 'synthetic-local-A').uiTheme, 'tangerine');
      assert.equal(profiles.find(u => u.id === 'synthetic-local-B').uiTheme, 'aqua');
      // New startup boundaries consume the actual active-user key, not forced React callbacks.
      await page.evaluate(() => localStorage.setItem('living-cost-manager:active-user:v1', 'synthetic-local-B'));
      await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.lcmTheme === 'aqua');
      await page.screenshot({ path: resolve(evidence, `independent-B-${width}.png`), fullPage: true });
      await page.evaluate(() => localStorage.setItem('living-cost-manager:active-user:v1', 'synthetic-local-A'));
      await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.lcmTheme === 'tangerine');
      assert.deepEqual(errors, []);
      results.push({ width, themeModeCombinations: 10, localABReloadIsolation: true, financialBytesUnchanged: true, errors, blockedExternalOrigins: [...new Set(external)] });
    } finally { await context.close(); }
  }
  await writeFile(resolve(evidence, 'independent-native-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
