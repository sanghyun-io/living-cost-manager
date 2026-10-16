// Row layout alignment smoke — local static export + synthetic guest ledger only.
// Blocks every non-origin request (no real API/HF/GPU), no login, no owner browser.
// Asserts header↔row field X alignment (nested advanced grid tracks), delete-mode
// 64px column, zero page-level horizontal overflow at desktop sizes (table scrolls
// itself if needed), and mobile 390px details disclosure + 44px hit targets.
// Evidence: /Users/sanghyun/services/lcm-ux-polish-evidence-20261016/layout-<uuid> (0700)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(process.env.LAYOUT_EXPORT ?? fileURLToPath(new URL('../out/', import.meta.url)));
const evidence = resolve(process.env.LAYOUT_EVIDENCE ?? `/Users/sanghyun/services/lcm-ux-polish-evidence-20261016/layout-${randomUUID()}`);
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
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

// Exact guest keys: AppUser id 'guest-layout-fixture' → getUserDataKey(active 'guest-layout-fixture').
const activeUserId = 'guest-layout-fixture';
const storageKey = 'living-cost-manager:user:' + encodeURIComponent(activeUserId) + ':v1';
const costs = [
  // 짧고 긴 이름 두 행 + keep 라벨 행: 열 폭이 이름/버튼 라벨 길이에 흔들리지 않아야 한다.
  { id: 'layout-a', name: '짧은A', amount: 7000, periodMonths: 1, categoryId: 'subscription', paymentMethodId: 'bank-transfer', paymentOptionId: '', billingDay: 3, isEndOfMonth: false, billingAnchorDate: '2026-10-03', renewalStatus: 'keep', potentialMonthlySavings: 0, confirmedMonthlySavings: 0 },
  { id: 'layout-b', name: '아주 긴_synthetic 구독 항목 이름 확인용', amount: 17000, periodMonths: 12, categoryId: 'subscription', paymentMethodId: 'credit-card', paymentOptionId: '', billingDay: 20, isEndOfMonth: false, billingAnchorDate: '2026-10-20', renewalStatus: 'cancel-planned', potentialMonthlySavings: 5000, confirmedMonthlySavings: 0 },
  { id: 'layout-c', name: 'C 중간길이 항목', amount: 25000, periodMonths: 3, categoryId: 'telecom', paymentMethodId: 'cash', paymentOptionId: '', billingDay: 27, isEndOfMonth: true, billingAnchorDate: null, renewalStatus: 'unreviewed', potentialMonthlySavings: 0, confirmedMonthlySavings: 0 }
];

const browser = await chromium.launch({ headless: true });
const results = [];
async function open(viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const forbidden = [], errors = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    forbidden.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ storageKey, activeUserId, fixedCosts }) => {
    if (localStorage.getItem('layout-seeded')) return;
    localStorage.setItem('layout-seeded', '1');
    localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id: activeUserId, name: '레이아웃 테스트 사용자' }]));
    localStorage.setItem('living-cost-manager:active-user:v1', activeUserId);
    localStorage.setItem(storageKey, JSON.stringify({ monthlyIncome: 3000000, categories: [{ id: 'subscription', label: '구독' }, { id: 'telecom', label: '통신' }], cards: [], fixedCosts }));
  }, { storageKey, activeUserId, fixedCosts: costs });
  await page.goto(origin);
  await page.waitForFunction(count => document.querySelectorAll('.table-row:not(.table-head)').length === count, costs.length);
  const tour = page.getByRole('region', { name: '선택형 둘러보기' }).getByRole('button', { name: '건너뛰기' });
  if (await tour.count()) await tour.click().catch(() => undefined);
  await page.locator('.cost-list').evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - 10));
  return { page, context, forbidden, errors };
}

// header label wrapper boxes vs row field Input.Wrapper boxes (label-level coords,
// not Mantine internal padding), plus nested group alignment.
async function columnBoxes(page) {
  return page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x * 100) / 100, width: Math.round(r.width * 100) / 100 }; };
    const head = document.querySelector('.table-head');
    const headCells = Array.from(head.querySelectorAll(':scope > span'));
    const headGroup = Array.from(headCells[3].children);
    const row = document.querySelector('.table-row.cost-row');
    const field = (label) => row.querySelector(`.cost-cell-${label} .mantine-InputWrapper-root, .cost-cell-${label}`);
    const wrap = sel => { const el = row.querySelector(sel); return el ? box(el.closest('.mantine-InputWrapper-root') ?? el) : null; };
    const advanced = ['category', 'payment', 'payment-option', 'period', 'monthly'].map(name => wrap(`.cost-cell-${name} .mantine-Input-input`));
    return {
      head: {
        name: box(headCells[0]), amount: box(headCells[1]), due: box(headCells[2]),
        group: box(headCells[3]), advanced: headGroup.map(box), actions: box(headCells[4])
      },
      row: {
        name: box(row.querySelector('.cost-cell-name')), amount: box(row.querySelector('.cost-cell-amount')),
        due: box(row.querySelector('.cost-cell-due')), details: box(row.querySelector('.cost-row-details')),
        advanced, actions: box(row.querySelector('.row-secondary-actions'))
      },
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableScrolls: (() => { const t = document.querySelector('.table'); return t.scrollWidth - t.clientWidth; })()
    };
  });
}

function assertAligned(actual, expected, name, tolerance = 1) {
  if (expected === null || actual === null) { results.push({ check: name, pass: false, actual, expected }); assert.ok(false, `${name}: missing box`); }
  const dx = Math.abs(actual.x - expected.x);
  results.push({ check: name, pass: dx <= tolerance, dx, actual, expected });
  assert.ok(dx <= tolerance, `${name} header/row X off by ${dx}px (row ${actual.x} vs header ${expected.x})`);
}

// ── desktop 1440 & 1280: header↔field alignment, both rows, delete mode ─────────
for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 900 }]) {
  const { page, forbidden, errors } = await open(viewport);
  const boxes = await columnBoxes(page);
  results.push({ viewport, boxes });
  assertAligned(boxes.row.name, boxes.head.name, `${viewport.width} col-name`);
  assertAligned(boxes.row.amount, boxes.head.amount, `${viewport.width} col-amount`);
  assertAligned(boxes.row.due, boxes.head.due, `${viewport.width} col-due`);
  assertAligned(boxes.row.details, boxes.head.group, `${viewport.width} col-advanced-group`);
  for (const [i, label] of ['category', 'payment', 'payment-option', 'period', 'monthly'].entries()) {
    assertAligned(boxes.row.advanced[i], boxes.head.advanced[i], `${viewport.width} col-${label}`);
  }
  assertAligned(boxes.row.actions, boxes.head.actions, `${viewport.width} col-actions`);

  // 두 번째 행도 같은 X (이름 길이·버튼 라벨 무관)
  const second = await page.evaluate(() => {
    const rows = document.querySelectorAll('.table-row.cost-row');
    const b = el => Math.round(el.getBoundingClientRect().x * 100) / 100;
    return { amount: b(rows[1].querySelector('.cost-cell-amount')), details: b(rows[1].querySelector('.cost-row-details')), actions: b(rows[1].querySelector('.row-secondary-actions')) };
  });
  assert.ok(Math.abs(second.amount - boxes.row.amount.x) <= 1, 'row2 amount X drift');
  assert.ok(Math.abs(second.details - boxes.row.details.x) <= 1, 'row2 details X drift');
  assert.ok(Math.abs(second.actions - boxes.row.actions.x) <= 1, 'row2 actions X drift');

  // 페이지 가로 오버플로 0 — 필요 시 .table 만 스크롤한다.
  assert.equal(boxes.pageOverflow, 0, `${viewport.width} page-level horizontal overflow`);
  if (viewport.width === 1280) assert.ok(boxes.tableScrolls >= 0);

  // 삭제 모드: 마지막 64px 셀렉트 열과 header '선택' 정렬. ('항목 관리' details 먼저 열기)
  await page.locator('.editor-tools > summary').click();
  await page.getByRole('button', { name: '삭제 모드' }).click();
  await page.getByRole('button', { name: '선택 삭제' }).waitFor();
  const del = await page.evaluate(() => {
    const b = el => Math.round(el.getBoundingClientRect().x * 100) / 100;
    const head = document.querySelector('.table-head.delete-mode');
    const row = document.querySelector('.table-row.cost-row.delete-mode');
    return { header: b(head.querySelector('.th-actions')), headerWidth: head.querySelector('.th-actions').getBoundingClientRect().width, cell: b(row.querySelector('.delete-select-cell')), cellWidth: row.querySelector('.delete-select-cell').getBoundingClientRect().width };
  });
  results.push({ viewport, deleteMode: del });
  assert.ok(Math.abs(del.header - del.cell) <= 1, `delete-mode select X off: ${del.header} vs ${del.cell}`);
  assert.ok(Math.abs(del.cellWidth - 64) <= 1, `delete-mode select column not 64px: ${del.cellWidth}`);

  await page.screenshot({ path: resolve(evidence, `desktop-${viewport.width}.png`), fullPage: false, animations: 'disabled' });
  assert.deepEqual(forbidden, [], `unexpected external requests: ${forbidden.join(', ')}`);
  assert.deepEqual(errors, [], `page errors: ${errors.join(', ')}`);
  await page.context().close();
}

// ── tablet 768: header 숨김·스택·필드 전체 표시·페이지 오버플로 0 ─────────────────
{
  const { page, forbidden, errors } = await open({ width: 768, height: 1024 });
  const tablet = await page.evaluate(() => {
    const head = document.querySelector('.table-head');
    const details = document.querySelector('details.cost-row-details');
    const styles = getComputedStyle(head);
    const visible = sel => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      headHidden: styles.display === 'none',
      detailsOpen: details.open,
      summaryAbsent: !document.querySelector('summary.cost-details-toggle'),
      categoryVisible: visible('.cost-cell-category .mantine-Input-input'),
      monthlyVisible: visible('.cost-cell-monthly'),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  results.push({ tablet });
  assert.equal(tablet.headHidden, true);
  assert.equal(tablet.detailsOpen, true);
  assert.equal(tablet.summaryAbsent, true);
  assert.equal(tablet.categoryVisible, true);
  assert.equal(tablet.monthlyVisible, true);
  assert.equal(tablet.pageOverflow, 0);
  await page.screenshot({ path: resolve(evidence, 'tablet-768.png'), animations: 'disabled' });
  assert.deepEqual(errors, [], `page errors: ${errors.join(', ')}`);
  assert.deepEqual(forbidden, [], `unexpected external requests: ${forbidden.join(', ')}`);
  await page.context().close();
}

// ── mobile 390: 기본 접힘/토글/값 보존/44px/새 행 접힘+이름 포커스 ────────────────
{
  const { page, forbidden, errors } = await open({ width: 390, height: 844 });
  const initial = await page.evaluate(() => {
    const details = document.querySelector('details.cost-row-details');
    return { open: details.open, expanded: document.querySelector('summary.cost-details-toggle')?.getAttribute('aria-expanded') };
  });
  assert.deepEqual(initial, { open: false, expanded: 'false' }, 'mobile rows must start collapsed');
  // 이름·금액·납부일은 기본 노출
  for (const sel of ['.cost-cell-name .mantine-Input-input', '.cost-cell-amount .mantine-Input-input', '.cost-cell-due input[type="date"]']) {
    assert.ok(await page.evaluate(s => { const el = document.querySelector(s); const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel), `${sel} should be visible when collapsed`);
  }
  // 44px hit targets: summary + row action buttons
  const hits = await page.evaluate(() => {
    const b = el => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height * 100) / 100, w: Math.round(r.width * 100) / 100 }; };
    return {
      summary: b(document.querySelector('summary.cost-details-toggle')),
      menu: b(document.querySelector('.row-secondary-actions .mantine-ActionIcon-root')),
      protect: b(document.querySelectorAll('.row-secondary-actions .mantine-Button-root')[0])
    };
  });
  results.push({ mobileHits: hits });
  assert.ok(hits.summary.h >= 44 && hits.menu.h >= 44 && hits.protect.h >= 44, `hit targets under 44px: ${JSON.stringify(hits)}`);

  // 펼침 → 고급 필드 편집 → 접기 → 값 보존(언마운트 없음)
  await page.click('summary.cost-details-toggle');
  await page.waitForFunction(() => document.querySelector('details.cost-row-details').open);
  const amount = page.locator('.cost-row-details .cost-cell-amount, .cost-cell-amount').first();
  await page.evaluate(() => document.querySelectorAll('.cost-row')[0].scrollIntoView({ block: 'center' }));
  const period = page.locator('.cost-row').first().locator('.cost-cell-period input');
  await period.fill('6');
  await page.locator('.cost-row').first().locator('summary.cost-details-toggle').click();
  const retained = await page.evaluate(() => {
    const row = document.querySelector('.cost-row');
    return {
      open: row.querySelector('details').open,
      periodInDom: row.querySelectorAll('.cost-cell-period input').length,
      periodValue: row.querySelector('.cost-cell-period input').value,
      nameCount: row.querySelectorAll('.cost-cell-name input').length
    };
  });
  results.push({ mobileRetained: retained });
  assert.equal(retained.open, false);
  assert.equal(retained.periodInDom, 1, 'no duplicate/unmounted field');
  assert.ok(retained.periodValue.replace(/\D/g, '') === '6', `period draft lost: ${retained.periodValue}`);
  assert.equal(retained.nameCount, 1);

  // 새 행 추가: 상세는 접힌 채 이름에 포커스
  await page.getByRole('button', { name: '항목 추가' }).click();
  await page.waitForFunction(count => document.querySelectorAll('.table-row.cost-row').length === count, costs.length + 1);
  const added = await page.evaluate(() => {
    const rows = document.querySelectorAll('.table-row.cost-row');
    const last = rows[rows.length - 1];
    const active = document.activeElement;
    return {
      lastOpen: last.querySelector('details').open,
      focusedInLastRow: last.contains(active) && active.classList.contains('mantine-TextInput-input')
    };
  });
  results.push({ mobileAdded: added });
  assert.equal(added.lastOpen, false, 'added row must stay collapsed');
  assert.equal(added.focusedInLastRow, true, 'added row name must be focused');

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'mobile page overflow');
  await page.screenshot({ path: resolve(evidence, 'mobile-390-collapsed.png'), animations: 'disabled' });
  await page.locator('.cost-row').first().locator('summary.cost-details-toggle').click();
  await page.evaluate(() => document.querySelectorAll('.cost-row')[0].scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: resolve(evidence, 'mobile-390-open.png'), animations: 'disabled' });
  assert.deepEqual(errors, [], `page errors: ${errors.join(', ')}`);
  assert.deepEqual(forbidden, [], `unexpected external requests: ${forbidden.join(', ')}`);
  await page.context().close();
}

await writeFile(resolve(evidence, 'layout-evidence.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), origin, evidence,
  head: 'lcm-ux-polish feat/ux-polish-a98c952d', results
}, null, 2), { mode: 0o600 });
await browser.close();
server.close();

const failed = results.filter(r => r.pass === false);
console.log(JSON.stringify({ evidence, checks: results.length, failed: failed.length, failed }, null, 2));
if (failed.length) process.exitCode = 1;
console.log('LAYOUT-SMOKE PASS');
