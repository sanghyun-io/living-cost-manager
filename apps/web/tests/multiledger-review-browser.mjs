// Regression reproduction of the three independent-review findings. Every API
// call is mocked; only synthetic account/session/data fixtures are used.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const origin = process.env.LCM_BROWSER_ORIGIN ?? 'http://127.0.0.1:43187';
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch({ headless: true });
const dataKey = id => 'living-cost-manager:user:' + encodeURIComponent(id) + ':v1';
const ledgerKey = (a, w) => dataKey('ledger:' + JSON.stringify([a, w]));
const localBudget = amount => ({ monthlyIncome: 1000, categories: [{ id: 'other', label: '기타' }], cards: [], fixedCosts: [{ id: 'x', name: '테스트 비용', amount, categoryId: 'other', paymentMethodId: 'cash', paymentOptionId: '', periodMonths: 1, billingDay: 1, isEndOfMonth: false, billingAnchorDate: null }] });
const account = id => ({ id, email: id + '@example.test', name: id, emailVerified: true });
async function fixture() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const spaces = [{ id: 'one', name: '생활', role: 'owner' }, { id: 'two', name: '여행', role: 'owner' }, { id: 'view', name: '공유', role: 'viewer' }];
  let holdCreate = false, releaseCreate, posts = 0, invalidAccount = false;
  await context.route('https://api.gamja.top/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.replace('/living-cost-manager/v1', '');
    const a = req.headers().authorization?.includes('fixture-b') ? 'b' : 'a';
    let body;
    if (path === '/auth/login') { const id = req.postDataJSON().email.startsWith('b@') ? 'b' : 'a'; body = { user: account(id), accessToken: 'fixture-' + id, refreshToken: 'fixture-refresh-' + id, workspace: spaces[0] }; }
    else if (path === '/auth/logout') body = {};
    else if (path === '/me') { if (invalidAccount) { await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'synthetic revoked session' }) }); return; } body = { user: account(a) }; }
    else if (path === '/workspaces' && req.method() === 'GET') body = spaces;
    else if (path === '/workspaces' && req.method() === 'POST') {
      posts++;
      if (holdCreate) { holdCreate = false; await new Promise(resolve => { releaseCreate = resolve; }); await route.abort('failed'); return; }
      body = { workspace: { id: 'new', name: req.postDataJSON().name, role: 'owner' }, snapshot: { ...req.postDataJSON().initialBudget, workspaceId: 'new', syncVersion: 0 } };
    }
    else if (/\/snapshot\/history$/.test(path)) body = { entries: [] };
    else if (/\/snapshot$/.test(path)) { const id = path.split('/')[2], budget = localBudget(id === 'two' ? 200 : 100); body = { ...budget, workspaceId: id, syncVersion: 1, categories: budget.categories.map(x => ({ ...x, workspaceId: id })), fixedCosts: budget.fixedCosts.map(x => ({ ...x, workspaceId: id })) }; }
    else if (/\/members$/.test(path)) body = [{ id: 'member', workspaceId: path.split('/')[2], userId: a, email: account(a).email, name: a, role: spaces.find(w => w.id === path.split('/')[2])?.role ?? 'owner' }];
    else if (path.includes('invitations') || path.includes('templates')) body = [];
    else throw new Error('Unexpected API route ' + path);
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await page.addInitScript(({ spaces, source, two, sourceKey, twoKey }) => {
    if (localStorage.getItem('review-seeded')) return;
    localStorage.setItem('review-seeded', '1');
    const user = { id: 'a', email: 'a@example.test', name: 'a', emailVerified: true };
    localStorage.setItem('living-cost-manager:users:v1', JSON.stringify([{ id: 'server:a', name: 'a', serverUserId: 'a' }]));
    localStorage.setItem('living-cost-manager:active-user:v1', 'server:a');
    localStorage.setItem('living-cost-manager:server-session:v2', JSON.stringify({ token: 'fixture-a', refreshToken: 'fixture-refresh-a', user, workspace: spaces[0] }));
    localStorage.setItem(sourceKey, JSON.stringify(source)); localStorage.setItem(twoKey, JSON.stringify(two));
  }, { spaces, source: localBudget(100), two: localBudget(200), sourceKey: dataKey('server:a'), twoKey: ledgerKey('a', 'two') });
  await page.goto(origin);
  const chooser = () => page.getByLabel('현재 가계부', { exact: true });
  const amount = () => page.getByLabel('금액', { exact: true }).first();
  await chooser().waitFor(); await chooser().selectOption('two');
  await page.waitForFunction(() => document.querySelector('input[aria-label="금액"]')?.value === '200');
  const waitAmount = value => page.waitForFunction(value => document.querySelector('input[aria-label="금액"]')?.value === value, value);
  const login = async id => {
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    const modal = page.getByRole('dialog'); await modal.getByLabel('이메일', { exact: true }).fill(id + '@example.test');
    await modal.getByLabel('비밀번호', { exact: true }).fill('synthetic-passphrase');
    await modal.getByRole('button', { name: '로그인', exact: true }).click(); await chooser().waitFor();
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('living-cost-manager:server-session:v2'))?.user.id === id, id);
    await page.getByRole('button', { name: '데이터 관리 닫기' }).click();
  };
  const startHeld = async () => {
    holdCreate = true;
    await page.getByRole('button', { name: '새 가계부', exact: true }).click();
    await page.getByLabel(/새 가계부 이름/).fill('미확인 테스트');
    await page.locator('.ledger-controls form').getByRole('button', { name: '확인', exact: true }).click();
    await page.getByText('가계부 생성 요청 처리 중입니다.', { exact: false }).waitFor(); assert.ok(releaseCreate);
  };
  return { context, page, spaces, chooser, amount, waitAmount, login, startHeld, invalidateAccount: () => { invalidAccount = true; }, release: () => releaseCreate(), posts: () => posts };
}
try {
  // P1: modal logout must not expose the obsolete 100 cache in place of 200.
  {
    const f = await fixture(), { page } = f;
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '이전 단일 가계부 원본(JSON) 내보내기' }).click();
    const download = await downloading;
    const originalPath = '/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/multiledger-review-synthetic-legacy.json';
    await download.saveAs(originalPath);
    assert.equal(JSON.parse(await readFile(originalPath, 'utf8')).fixedCosts[0].amount, 100);
    assert.equal(await f.amount().inputValue(), '200');
    await page.getByRole('button', { name: '서버 연결됨 · 동기화 관리' }).click();
    assert.equal(await page.locator('select[aria-label="현재 가계부"]').count(), 1);
    assert.equal(await page.getByLabel('서버 워크스페이스 선택').count(), 0);
    await page.getByRole('dialog').getByRole('button', { name: '서버 로그아웃', exact: true }).click();
    await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
    assert.equal(await page.getByLabel('금액', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(k => JSON.parse(localStorage.getItem(k)).fixedCosts[0].amount, ledgerKey('a', 'two')), 200);
    assert.equal(await page.evaluate(k => JSON.parse(localStorage.getItem(k)).fixedCosts[0].amount, dataKey('server:a')), 100);
    assert.match(await page.evaluate(() => localStorage.getItem('living-cost-manager:active-user:v1')), /^guest:/);
    await f.context.close(); console.log('PASS P1 modal logout 200 preserved / source100 never editable / one chooser');
  }
  // P1 sample round-trip, refreshed viewer role, and safe storage-failure exit.
  {
    const f = await fixture(), { page } = f;
    await page.getByRole('button', { name: '분리된 샘플 체험', exact: true }).click();
    await page.getByText('샘플 체험 중', { exact: false }).waitFor(); assert.equal(await f.chooser().isDisabled(), true);
    f.spaces[1].role = 'viewer';
    await page.getByRole('button', { name: '내 데이터로 시작 / 돌아가기', exact: true }).click(); await f.waitAmount('200');
    assert.equal(await f.chooser().inputValue(), 'two'); assert.equal(await f.amount().isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '이름 변경', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '분리된 샘플 체험', exact: true }).click();
    await page.getByText('샘플 체험 중', { exact: false }).waitFor();
    await page.getByRole('button', { name: '서버 로그아웃', exact: true }).click();
    await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
    assert.equal(await page.getByLabel('금액', { exact: true }).count(), 0);
    assert.match(await page.evaluate(() => localStorage.getItem('living-cost-manager:active-user:v1')), /^guest:/);
    assert.equal(await page.evaluate(k => JSON.parse(localStorage.getItem(k)).fixedCosts[0].amount, ledgerKey('a', 'two')), 200);
    await f.context.close(); console.log('PASS P1 sample account+ledger return200 / refreshed viewer / sample logout distinct guest');
  }
  {
    const f = await fixture(), { page } = f;
    await page.getByRole('button', { name: '분리된 샘플 체험', exact: true }).click();
    await page.getByText('샘플 체험 중', { exact: false }).waitFor(); f.invalidateAccount();
    await page.getByRole('button', { name: '내 데이터로 시작 / 돌아가기', exact: true }).click();
    await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
    assert.equal(await page.getByLabel('금액', { exact: true }).count(), 0);
    assert.match(await page.evaluate(() => localStorage.getItem('living-cost-manager:active-user:v1')), /^guest:/);
    assert.equal(await page.evaluate(k => JSON.parse(localStorage.getItem(k)).fixedCosts[0].amount, ledgerKey('a', 'two')), 200);
    await f.context.close(); console.log('PASS P1 invalid sample-return authentication → distinct empty guest, ledger200 preserved');
  }
  {
    const f = await fixture(), { page } = f;
    await page.evaluate(k => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === k) throw new DOMException('fixture-quota', 'QuotaExceededError'); return original.call(this, key, value); }; }, ledgerKey('a', 'two'));
    await page.getByRole('button', { name: '서버 로그아웃', exact: true }).click();
    await page.getByText('전환을 중단했습니다.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '로그인', exact: true }).count(), 0); assert.equal(await f.amount().inputValue(), '200');
    assert.equal(await f.chooser().isDisabled(), true);
    await f.context.close(); console.log('PASS P1 failed persistence refuses logout / chooser readiness disabled');
  }
  // P2: switching aggregate/view scope cannot erase account mutation pending.
  {
    const f = await fixture(), { page } = f;
    await f.startHeld(); await page.getByRole('checkbox', { name: '합산 보기', exact: true }).check();
    assert.equal(await page.getByRole('button', { name: '새 가계부', exact: true }).isDisabled(), true);
    await f.chooser().selectOption('one');
    assert.equal(await page.getByRole('button', { name: '새 가계부', exact: true }).isDisabled(), true);
    f.release(); await page.getByText('생성 결과를 확인할 수 없습니다.', { exact: false }).waitFor();
    assert.equal(f.posts(), 1); assert.equal(await page.getByRole('button', { name: '새 가계부', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '가계부 목록 새로고침' }).click();
    await page.getByRole('region', { name: '생성 결과 확인' }).getByText('생활', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '새 가계부', exact: true }).isDisabled(), true);
    await page.screenshot({ path: process.env.LCM_REVIEW_SCREENSHOT ?? '/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/multiledger-review-uncertainty.png', fullPage: true });
    await page.getByRole('button', { name: '목록을 직접 확인했고 지연 완료·중복 위험을 이해합니다' }).click();
    assert.equal(await page.getByRole('button', { name: '새 가계부', exact: true }).isDisabled(), false);
    assert.equal(f.posts(), 1); await f.context.close(); console.log('PASS P2 heldPOST→aggregate→switch→failure pending/uncertainty retained; refresh alone not retry');
  }
  // P2 account B is independent; A's late failure survives returning/reload.
  {
    const f = await fixture(), { page } = f;
    await f.startHeld(); await page.getByRole('button', { name: '서버 로그아웃', exact: true }).click(); await f.login('b');
    f.release(); await page.waitForFunction(() => localStorage.getItem('living-cost-manager:ledger-creation:a') !== null);
    assert.equal(await page.getByText('생성 결과를 확인할 수 없습니다.', { exact: false }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '새 가계부', exact: true }).isDisabled(), false);
    await page.locator('header').getByRole('button', { name: '서버 로그아웃', exact: true }).click(); await f.login('a');
    await page.getByText('생성 결과를 확인할 수 없습니다.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '새 가계부', exact: true }).isDisabled(), true);
    await page.reload(); await page.getByText('이 계정의 가계부 생성 결과가 미확인입니다.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '새 가계부', exact: true }).isDisabled(), true); assert.equal(f.posts(), 1);
    await f.context.close(); console.log('PASS P2 heldPOST→logout→B→latefailure→A→reload account-specific uncertainty; no extra POST');
  }
} finally { await browser.close(); }
