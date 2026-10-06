// Fresh, disposable contexts only: no browser profile or account data.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const output = process.env.LCM_UI_EVIDENCE;
if (!output) throw new Error('LCM_UI_EVIDENCE required');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [name, url] of [
    ['toss', 'https://toss.im/'],
    ['linear', 'https://linear.app/docs/display-options'],
    ['stripe', 'https://docs.stripe.com/dashboard/basics'],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${output}/reference-${name}.png` });
      results.push({ name, requested: url, actual: page.url(), title: await page.title() });
    } catch (error) { results.push({ name, error: String(error) }); }
    finally { await context.close(); }
  }
  for (const width of [1440, 1280, 390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    await context.route('**/*', route => {
      const req = route.request();
      if (!['GET', 'HEAD'].includes(req.method()) || new URL(req.url()).origin !== 'https://living-cost-manager.gamja.top') return route.abort();
      return route.continue();
    });
    try {
      await page.goto('https://living-cost-manager.gamja.top');
      await page.getByLabel('빠른 추가', { exact: true }).waitFor();
      await page.screenshot({ path: `${output}/before-empty-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: '분리된 샘플 체험', exact: true }).click();
      await page.getByText('샘플 체험 중 · 내 데이터와 분리된 예시입니다.', { exact: true }).waitFor();
      await page.screenshot({ path: `${output}/before-sample-${width}.png`, fullPage: true });
      results.push({ width, overflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) });
    } finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(`${output}/audit.json`, JSON.stringify(results, null, 2)); }
