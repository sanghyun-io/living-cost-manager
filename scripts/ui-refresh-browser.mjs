import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = process.env.LCM_E2E_ORIGIN;
assert.ok(origin, 'LCM_E2E_ORIGIN required');
if (process.env.LCM_E2E_PUBLIC === '1') {
  assert.ok(['https://living-cost-manager.gamja.top', 'https://living-cost-manager.pages.dev'].includes(origin));
} else assert.equal(new URL(origin).hostname, '127.0.0.1');
const evidence = process.env.LCM_UI_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const results = [];
function luminance(color) {
  const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255);
  return rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
try {
  for (const width of [1440, 1280, 390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    const errors = [];
    await context.route('**/*', route => {
      const request = route.request();
      if (process.env.LCM_E2E_PUBLIC === '1' && new URL(request.url()).origin === 'https://static.cloudflareinsights.com') return route.abort();
      if (!['GET', 'HEAD'].includes(request.method()) || new URL(request.url()).origin !== origin) {
        errors.push(`unexpected egress: ${request.method()} ${new URL(request.url()).origin}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const shot = async name => {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));
      if (evidence) await page.screenshot({ path: `${evidence}/after-${name}-${width}.png`, fullPage: name !== 'settings', animations: 'disabled' });
    };
    async function layout() {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page never scrolls horizontally');
      const header = await page.locator('.app-header-shell').boundingBox();
      const inner = await page.locator('.app-header').boundingBox();
      const main = await page.locator('main.page-shell').boundingBox();
      assert.equal(Math.round(header.width), width, 'outer header spans viewport');
      assert.ok(inner.width <= 1240 && Math.abs(inner.x - main.x) < 1 && Math.abs(inner.width - main.width) < 1, 'inner header and content align');
      const budget = await page.getByRole('region', { name: '핵심 지표' }).boundingBox();
      const dues = await page.getByRole('region', { name: '예측 및 절감 인사이트' }).boundingBox();
      const editing = await page.locator('.cost-list').boundingBox();
      assert.ok(budget.y < editing.y && dues.y < editing.y, 'budget and actual dues are visible before editing');
      if (width >= 861) assert.ok(Math.abs(budget.y - dues.y) < 1 && dues.x > budget.x, 'desktop overview is two columns');
      else assert.ok(dues.y >= budget.y + budget.height, 'mobile overview stacks');
      assert.equal(await page.locator('.metric-cell').count(), 2, 'only two primary budget figures');
      assert.equal(await page.locator('.budget-facts > div').count(), 3, 'secondary facts remain available');
      if (width < 768) {
        for (const control of await page.locator('.cost-list .mantine-Input-input, .cost-list button, .hero-right input').all()) {
          const box = await control.boundingBox();
          if (box) assert.ok(box.height >= 44, 'touch controls are at least 44px high');
        }
      }
    }
    try {
      await page.goto(origin);
      const quick = page.getByLabel('빠른 추가', { exact: true });
      await quick.waitFor();
      await page.getByText('항목과 기준 납부일을 등록하면 예정 결제를 볼 수 있습니다.', { exact: true }).waitFor();
      assert.equal(await page.locator('.diagram').count(), 0, 'no decorative empty chart');
      await layout();
      await shot('empty');
      await page.getByRole('button', { name: '분리된 샘플 체험', exact: true }).click();
      await page.getByText('샘플 체험 중 · 내 데이터와 분리된 예시입니다.', { exact: true }).waitFor();
      await page.getByText(/일정 미확인 5건은 합계와 알림에서 제외/).waitFor();
      await layout();
      assert.equal(await page.locator('.cat-dot').count(), 0, 'no decorative rainbow category dots');
      const styles = await page.locator('.budget-overview').evaluate(el => ({
        surface: getComputedStyle(el).backgroundColor,
        label: getComputedStyle(el.querySelector('.metric-cell .mantine-Text-root')).color,
        body: getComputedStyle(el.querySelector('.metric-value')).color,
      }));
      assert.ok(contrast(styles.label, styles.surface) >= 4.5, 'secondary financial labels meet AA contrast');
      assert.ok(contrast(styles.body, styles.surface) >= 4.5, 'amounts meet AA contrast');
      const primary = await page.getByRole('button', { name: '항목 추가', exact: true }).evaluate(el => ({ text: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
      assert.ok(contrast(primary.text, primary.bg) >= 4.5, 'primary action label meets AA contrast');
      await shot('sample');
      await page.getByRole('button', { name: '내 데이터로 시작 / 돌아가기', exact: true }).click();
      await quick.fill('연간 예시 120000원 매년'); await quick.press('Enter');
      const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; });
      await page.getByLabel('연간 예시 기준 납부일', { exact: true }).fill(today);
      await page.locator('.due-total').filter({ hasText: '120,000' }).waitFor();
      assert.ok((await page.locator('.metric-grid').innerText()).includes('10,000'), 'annual amount is monthly-normalized only in budget');
      await page.getByRole('button', { name: '연간 예시 · 임박 미검토 편집', exact: true }).click();
      assert.equal(await page.getByLabel('항목명', { exact: true }).evaluate(el => el === document.activeElement), true);
      const nameBox = await page.getByLabel('항목명', { exact: true }).boundingBox();
      const amountBox = await page.getByLabel('금액', { exact: true }).boundingBox();
      const cycleBox = await page.getByLabel('주기', { exact: true }).boundingBox();
      if (width < 561) {
        assert.ok(Math.abs(amountBox.y - cycleBox.y) < 1 && amountBox.x < cycleBox.x, 'amount/cycle are side by side on mobile');
        assert.ok(nameBox.width > amountBox.width * 1.8, 'name retains full row width');
      }
      await shot('scheduled');
      const dataButton = page.locator('header').getByRole('button', { name: '데이터 관리', exact: true });
      await dataButton.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const consent = dialog.getByRole('checkbox', { name: '서비스 개선을 위한 사용 통계 제공(선택)', exact: true });
      await consent.waitFor();
      assert.equal(await consent.isChecked(), false, 'statistics stay default-off in discoverable Data management');
      await page.waitForFunction(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return false;
        for (let el = dialog; el; el = el.parentElement) if (getComputedStyle(el).opacity !== '1') return false;
        return true;
      });
      if (width === 390 || width === 1440) await shot('settings');
      for (let i=0; i<12; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'focus is trapped in modal');
      }
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await dataButton.evaluate(el => el === document.activeElement), true, 'Escape restores trigger focus');
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'), 'keyboard focus ring remains visible');
      await page.getByRole('button', { name: '색상 모드 전환', exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.mantineColorScheme === 'dark');
      const dark = await page.locator('.budget-overview').evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el.querySelector('.metric-cell .mantine-Text-root')).color }));
      assert.ok(contrast(dark.text, dark.bg) >= 4.5, 'dark secondary labels meet AA');
      const darkPrimary = await page.getByRole('button', { name: '항목 추가', exact: true }).evaluate(el => ({ text: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
      assert.ok(contrast(darkPrimary.text, darkPrimary.bg) >= 4.5, 'dark primary button label meets AA');
      await layout();
      if (width === 390 || width === 1440) await shot('dark');
      assert.deepEqual(errors, []);
      results.push({ width, checks: 'layout/alignment/contrast/font/touch/empty/sample/schedule/queue/modal/focus/dark', result: 'PASS' });
      console.log(`PASS UI refresh ${width}: hierarchy, actual vs normalized due, isolated sample, responsive edit/filter, contrast, touch, modal focus, dark`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  if (evidence) await writeFile(`${evidence}/ui-results.json`, JSON.stringify(results, null, 2));
}
