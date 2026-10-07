// Run against the local static export only. ALL API requests are intercepted;
// the synthetic fixture session is not a production credential.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const origin = process.env.LCM_BROWSER_ORIGIN ?? 'http://127.0.0.1:43187';
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const user = { id: 'fixture-account', email: 'fixture@example.test', name: 'Fixture', emailVerified: true };
const workspaces = [{ id: 'one', name: '생활 장부', role: 'owner' }, { id: 'two', name: '여행 장부', role: 'owner' }, { id: 'view', name: '보기 장부', role: 'viewer' }];
const snapshot = (amount, workspaceId) => ({ monthlyIncome: 5000, categories: [{ id: 'other', label: '기타' }], cards: [], fixedCosts: [{ id: 'cost', name: '같은 지출', categoryId: 'other', paymentMethodId: 'cash', paymentOptionId: '', amount, periodMonths: 3, billingDay: 1, isEndOfMonth: false, billingAnchorDate: null }] });
const serverSnapshot = id => { const local = snapshot(id === 'one' ? 900 : 600, id); return { ...local, workspaceId: id, syncVersion: 1, categories: local.categories.map(x => ({ ...x, workspaceId: id })), fixedCosts: local.fixedCosts.map(x => ({ ...x, workspaceId: id })) }; };
const profile = id => 'ledger:' + JSON.stringify([user.id, id]);
const key = id => 'living-cost-manager:user:' + encodeURIComponent(id) + ':v1';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await context.newPage();
let releasePull, releasePush, holdPull = false, holdPush = false, abortCreate = false, creates = 0;
const createdInputs = [];
const createdBudgets = new Map();
const puts = [];
await context.route('https://api.gamja.top/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname.replace('/living-cost-manager/v1', '');
  let body;
  if (path === '/me') body = { user };
  else if (path === '/workspaces' && req.method() === 'GET') body = workspaces;
  else if (path === '/workspaces' && req.method() === 'POST') {
    creates++; const input = req.postDataJSON(); createdInputs.push(input);
    if (abortCreate) { abortCreate = false; await route.abort('timedout'); return; }
    const workspace = { id: 'created-' + creates, name: input.name, role: 'owner' }; workspaces.push(workspace);
    const budget = { ...input.initialBudget, workspaceId: workspace.id, syncVersion: 0, categories: input.initialBudget.categories.map(row => ({ ...row, workspaceId: workspace.id })), cards: input.initialBudget.cards.map(row => ({ ...row, workspaceId: workspace.id })), fixedCosts: input.initialBudget.fixedCosts.map(row => ({ ...row, workspaceId: workspace.id })) };
    createdBudgets.set(workspace.id, budget); body = { workspace, snapshot: budget };
  }
  else if (path === '/workspaces/aggregate') body = { currency: 'KRW', timeZone: 'Asia/Seoul', asOf: '2026-10-07T00:00:00Z', fromDate: '2026-10-07', untilDateExclusive: '2026-11-06', workspaces: [], totals: { monthlyNormalizedExpense: 66.666, fixedCostCount: 2, knownScheduleCount: 0, unknownScheduleCount: 2, dueOccurrenceCount: 0, thirtyDayDue: null } };
  else if (/\/snapshot\/history$/.test(path)) body = { entries: [] };
  else if (/\/snapshot$/.test(path)) {
    const id = path.split('/')[2];
    if (req.method() === 'PUT') { puts.push({ id, snapshot: req.postDataJSON() }); if (holdPush) { holdPush = false; await new Promise(resolve => { releasePush = resolve; }); } body = { ...req.postDataJSON(), syncVersion: 2 }; }
    else { if (holdPull) { holdPull = false; await new Promise(resolve => { releasePull = resolve; }); } body = createdBudgets.get(id) ?? serverSnapshot(id); }
  }
  else if (/\/members$/.test(path)) body = [{ id: 'member', workspaceId: path.split('/')[2], userId: user.id, name: user.name, email: user.email, role: workspaces.find(w => w.id === path.split('/')[2])?.role ?? 'owner' }];
  else if (path.includes('invitations') || path.includes('templates')) body = [];
  else if (path === '/auth/logout') body = {};
  else throw new Error('Unexpected mocked API route: ' + req.method() + ' ' + path);
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
});
await page.addInitScript(({ user, workspaces, original, second, keyOne, keyTwo }) => {
  if (localStorage.getItem('fixture-seeded')) return;
  localStorage.setItem('fixture-seeded', '1');
  localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id: 'server:' + user.id, name: user.name, serverUserId: user.id }]));
  localStorage.setItem('living-cost-manager:active-user:v1', 'server:' + user.id);
  localStorage.setItem('living-cost-manager:server-session:v2', JSON.stringify({ token: 'synthetic-fixture-access', refreshToken: 'synthetic-fixture-refresh', user, workspace: workspaces[0] }));
  localStorage.setItem(keyOne, JSON.stringify(original)); localStorage.setItem(keyTwo, JSON.stringify(second));
}, { user, workspaces, original: snapshot(100), second: snapshot(200), keyOne: key('server:' + user.id), keyTwo: key(profile('two')) });
try {
  await page.goto(origin);
  await page.getByLabel('현재 가계부', { exact: true }).waitFor();
  const amount = () => page.getByLabel('금액', { exact: true }).first();
  await amount().fill('111'); await amount().blur();
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('two');
  await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '200');
  assert.equal(await amount().inputValue(), '200');
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('one');
  await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '111');
  assert.equal(await amount().inputValue(), '111');
  // A late remote pull must not replace the newly selected ledger.
  await page.getByRole('button', { name: '서버 연결됨 · 동기화 관리' }).click();
  page.once('dialog', dialog => dialog.accept()); holdPull = true;
  await page.getByRole('button', { name: /서버 데이터 불러오기/ }).click();
  await page.waitForFunction(() => true); // click completed; route promise is held
  assert.ok(releasePull, 'pull request started');
  await page.getByRole('button', { name: '데이터 관리 닫기' }).click();
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('two');
  releasePull();
  await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '200');
  assert.equal(await amount().inputValue(), '200');
  // A late push updates only its outgoing ledger; cannot adopt B's baseline.
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('one');
  await page.getByRole('button', { name: '서버 연결됨 · 동기화 관리' }).click();
  holdPush = true; page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /지금 동기화/ }).click();
  assert.ok(releasePush, 'push request started');
  await page.getByRole('button', { name: '데이터 관리 닫기' }).click();
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('two'); releasePush();
  await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '200');
  assert.equal(puts.at(-1).id, 'one'); assert.equal(puts.at(-1).snapshot.fixedCosts[0].amount, 111);
  // Explicit selection only; no financial editing/income in aggregate state.
  await page.getByRole('checkbox', { name: '합산 보기', exact: true }).check();
  assert.equal(await page.locator('.ledger-aggregate-selection input:checked').count(), 0);
  await page.getByLabel('생활 장부', { exact: true }).check(); await page.getByLabel('여행 장부', { exact: true }).check();
  await page.getByRole('button', { name: '선택한 가계부 합산 조회' }).click();
  await page.getByRole('heading', { name: '선택 가계부 합산 · 읽기 전용' }).waitFor();
  assert.ok((await page.locator('.ledger-summary').textContent()).includes('각각 합산'));
  assert.ok(!(await page.locator('.ledger-summary').textContent()).includes('99,999,999'));
  assert.equal(await page.getByLabel('금액', { exact: true }).count(), 0);
  await page.getByRole('checkbox', { name: '합산 보기', exact: true }).uncheck();
  // Authenticated template application creates a separate server ledger, never
  // disconnects the account or overwrites the original cached data.
  const before = await page.evaluate(key => localStorage.getItem(key), key(profile('two')));
  await page.getByRole('button', { name: '템플릿', exact: true }).click();
  const applyRegion = page.getByRole('region', { name: '새 공간에 템플릿 적용' });
  await applyRegion.waitFor();
  const fields = applyRegion.locator('input');
  await fields.first().waitFor();
  for (let i = 0; i < await fields.count(); i++) await fields.nth(i).fill(i === 0 ? '1000' : '100');
  await page.getByRole('button', { name: '금액 확인 후 새 공간 만들기' }).click();
  await page.getByText('새 가계부를 만들었습니다.', { exact: false }).waitFor();
  assert.equal(creates, 1); assert.equal(createdInputs[0].initialBudget.monthlyIncome, 1000);
  assert.ok(createdInputs[0].initialBudget.fixedCosts.every(cost => cost.amount === 100 && !('workspaceId' in cost)));
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key(profile('two'))), before);
  assert.equal(await page.getByLabel('현재 가계부', { exact: true }).inputValue(), 'two');
  assert.ok(await page.getByRole('button', { name: '서버 로그아웃', exact: true }).isVisible());
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('created-1');
  await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '100');
  assert.equal(await amount().inputValue(), '100'); // brand-new cache initializes safely
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('two');
  await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '200');
  // Ambiguous POST outcome cannot trigger an automatic duplicate retry.
  await page.getByRole('button', { name: '새 가계부', exact: true }).click();
  await page.getByLabel(/새 가계부 이름/).fill('불확실 장부'); abortCreate = true;
  await page.locator('.ledger-controls form').getByRole('button', { name: '확인', exact: true }).click();
  await page.getByText('생성 결과를 확인할 수 없습니다.', { exact: false }).waitFor();
  assert.equal(creates, 2);
  assert.equal(await page.locator('.ledger-controls form').getByRole('button', { name: '확인', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '가계부 목록 새로고침', exact: true }).click();
  await page.getByText('최신 가계부 목록을 표시했습니다.', { exact: false }).waitFor();
  assert.equal(await page.locator('.ledger-controls form').getByRole('button', { name: '확인', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '목록을 직접 확인했고 지연 완료·중복 위험을 이해합니다' }).click();
  await page.locator('.ledger-controls form').getByRole('button', { name: '취소', exact: true }).click();
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('view');
  await page.getByText('보기 전용 가계부입니다.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: '항목 추가', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '이름 변경', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // Offline local edits persist only to B; undo from B cannot appear in A.
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('two');
  await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '200');
  await context.setOffline(true);
  await amount().fill('222'); await amount().blur();
  await page.getByRole('button', { name: '삭제 모드', exact: true }).click();
  await page.getByLabel('삭제 선택', { exact: true }).check();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '선택 삭제', exact: true }).click();
  await page.getByRole('button', { name: '최근 삭제 취소', exact: true }).waitFor();
  await page.getByLabel('현재 가계부', { exact: true }).selectOption('one');
  await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '111');
  assert.equal(await page.getByRole('button', { name: '최근 삭제 취소', exact: true }).count(), 0);
  const bCache = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key(profile('two')));
  assert.equal(bCache.fixedCosts.length, 0); assert.equal(await amount().inputValue(), '111');
  await context.setOffline(false);
  // Real same-origin second-tab write blocks rather than silently overwrites.
  const tab = await context.newPage(); await tab.goto(origin);
  await tab.evaluate(key => { const value = JSON.parse(localStorage.getItem(key)); value.fixedCosts[0].amount = 777; localStorage.setItem(key, JSON.stringify(value)); }, key(profile('one')));
  await page.getByText('다른 탭에서 이 가계부를 변경했습니다.', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('현재 가계부', { exact: true }).isDisabled(), true);
  await tab.evaluate(key => localStorage.setItem(key, '1'), key('server:' + user.id) + ':erased');
  await page.getByText('다른 탭에서 계정이 삭제되어', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: '항목 추가', exact: true }).isDisabled(), true);
  await tab.close();
  console.log('PASS mobile cache switching, late pull/push, explicit aggregate, no income, authenticated template/original immutable, uncertain create/no retry, viewer roles, overflow, offline/undo scope, cross-tab conflict/erasure');
} finally { await browser.close(); }
