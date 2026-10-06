// Synthetic account and purpose-created DB only; never a real browser profile.
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { assertVerificationTarget } from './verification-target.mjs';
const origin = process.env.LCM_E2E_ORIGIN, api = process.env.LCM_E2E_API;
assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.equal(new URL(api).hostname, '127.0.0.1');
const prisma = new PrismaClient({ datasourceUrl: await assertVerificationTarget(process.env) });
const email = `template-browser-${crypto.randomUUID()}@example.test`, password = 'isolated-template-password-123';
const registration = await fetch(api+'/auth/register', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({email,password,name:'Synthetic Author'}) });
assert.equal(registration.status,201); const fixture=await registration.json();
await prisma.user.update({where:{id:fixture.user.id},data:{emailVerifiedAt:new Date()}});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const evidence=process.env.LCM_TEMPLATE_EVIDENCE;
if(evidence) await mkdir(evidence,{recursive:true});
const contexts=[], allErrors=[], marketingWrites=[];
async function context(width){ const c=await browser.newContext({viewport:{width,height:1000},locale:'ko-KR'}); contexts.push(c); await c.route('**/*',route=> { if(new URL(route.request().url()).pathname.endsWith('/marketing/events')){marketingWrites.push(route.request().method());return route.abort();} return [origin,api].includes(new URL(route.request().url()).origin)?route.continue():route.abort(); }); return c; }
const key = page=>page.evaluate(()=> 'living-cost-manager:user:'+encodeURIComponent(localStorage.getItem('living-cost-manager:active-user:v1'))+':v1');
const persisted=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('living-cost-manager:user:'+encodeURIComponent(localStorage.getItem('living-cost-manager:active-user:v1'))+':v1')));
async function wait(check){ for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('template condition timeout'); }
try {
  for(const width of [1440,390,360]){
    const author=await (await context(width)).newPage(); const errors=[]; author.on('pageerror',e=>{errors.push(e.message);allErrors.push(e.message);}); author.on('dialog',d=>d.accept());
    await author.goto(origin); await author.locator('header').getByRole('button',{name:'로그인',exact:true}).click();
    await author.getByLabel('이메일',{exact:true}).fill(email); await author.getByLabel('비밀번호',{exact:true}).fill(password);
    await author.getByRole('dialog').getByRole('button',{name:'로그인',exact:true}).click();
    await author.getByRole('button',{name:'데이터 관리 닫기',exact:true}).click();
    await author.locator('header').getByRole('button',{name:'템플릿',exact:true}).click();
    const dialog=author.getByRole('dialog');
    for(const name of ['독립 생활 시작','가족 생활비 정리','구독·연간 결제 점검']){await dialog.getByRole('button',{name,exact:true}).click();assert.equal(await dialog.getByLabel('템플릿 제목',{exact:true}).inputValue(),name);}
    await dialog.getByRole('button',{name:'독립 생활 시작',exact:true}).click();
    await dialog.getByLabel('템플릿 제목',{exact:true}).fill(`예시 설계도 ${width}`);
    await dialog.getByLabel('공개 작성자 표시명 (선택)',{exact:true}).fill('예시 작성자');
    await dialog.getByLabel('템플릿 설명',{exact:true}).fill('<img src=x onerror=window.templateXss=true>');
    assert.equal(await dialog.locator('img').count(),0); assert.equal(await author.evaluate(()=>window.templateXss),undefined);
    await dialog.getByRole('button',{name:'나만의 템플릿 저장',exact:true}).click();
    await dialog.getByRole('button',{name:'템플릿 수정 저장',exact:true}).waitFor();
    const publish=dialog.getByRole('button',{name:'검토한 저장본 공유 링크 만들기',exact:true});
    assert.equal(await publish.isDisabled(),true);
    await dialog.getByLabel('공개할 모든 문구를 직접 검토했고 개인정보를 넣지 않았습니다',{exact:true}).check();
    await dialog.getByLabel('직접 제작했거나 공유할 권한이 있는 설계도입니다',{exact:true}).check();
    await publish.click();
    const link=dialog.getByLabel('공유 링크 (복사해서 전달)',{exact:true}); await link.waitFor(); const url=await link.inputValue();
    assert.ok(url.startsWith(origin+'/#template='));
    const token=new URL(url).hash.slice(10);
    const response=await fetch(api+'/template-shares/'+token,{cache:'no-store'}); assert.equal(response.headers.get('cache-control'),'no-store');
    const body=await response.json();assert.deepEqual(Object.keys(body),['blueprint']);
    assert.deepEqual(Object.keys(body.blueprint).sort(),['authorLabel','description','items','title']);
    for(const item of body.blueprint.items) assert.deepEqual(Object.keys(item).sort(),['category','name','periodMonths']);
    assert.ok(await author.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(evidence) await author.screenshot({path:`${evidence}/template-author-${width}.png`,animations:'disabled'});
    const reader=await (await context(width)).newPage();reader.on('pageerror',e=>{errors.push(e.message);allErrors.push(e.message);});
    await reader.goto(origin);const quick=reader.getByLabel('빠른 추가',{exact:true});await quick.fill('보존 항목 999원 매달');await quick.press('Enter');
    await wait(async()=>(await persisted(reader)).fixedCosts.length===1);
    const originalKey=await key(reader), original=await reader.evaluate(k=>localStorage.getItem(k),originalKey);
    await reader.locator('header').getByRole('button',{name:'데이터 관리',exact:true}).click();
    await reader.getByRole('checkbox',{name:'서비스 개선을 위한 사용 통계 제공(선택)',exact:true}).check();
    await reader.getByRole('button',{name:'데이터 관리 닫기',exact:true}).click();
    await reader.goto(url);const readDialog=reader.getByRole('dialog');await readDialog.getByLabel('템플릿 제목',{exact:true}).filter({visible:true}).waitFor();
    await wait(async()=>(await readDialog.getByLabel('템플릿 제목',{exact:true}).inputValue())===`예시 설계도 ${width}`);
    assert.equal(await readDialog.locator('img').count(),0);assert.equal(await reader.evaluate(()=>window.templateXss),undefined,'untrusted authored text never becomes HTML');
    const apply=readDialog.getByRole('button',{name:'금액 확인 후 새 공간 만들기',exact:true});assert.equal(await apply.isDisabled(),true,'unset is not free');
    await readDialog.getByLabel('새 공간 월 수입 (원)',{exact:true}).fill('2000000');
    for(const item of body.blueprint.items) await readDialog.getByLabel(item.name+' 실제 청구 금액 (원)',{exact:true}).fill('100');
    if(evidence) await reader.screenshot({path:`${evidence}/template-reader-${width}.png`,animations:'disabled'});
    await apply.click();await readDialog.waitFor({state:'hidden'});
    const current=await persisted(reader);assert.equal(current.fixedCosts.length,3);assert.equal(current.monthlyIncome,2000000);
    assert.equal(await reader.evaluate(k=>localStorage.getItem(k),originalKey),original);
    assert.notEqual(await key(reader),originalKey);
    assert.ok(current.fixedCosts.every(item=>item.billingAnchorDate===null&&item.renewalStatus==='unreviewed'&&item.confirmedMonthlySavings===0));
    assert.equal(current.cards.length,0);
    await reader.getByText(/일정 미확인 3건은 합계와 알림에서 제외/).waitFor();
    assert.equal(new URL(reader.url()).hash,'','successful application consumes the share fragment instead of reopening on load');
    await reader.reload();await reader.getByRole('button',{name:'템플릿 적용 전 공간으로 돌아가기',exact:true}).waitFor();
    await reader.getByRole('button',{name:'템플릿 적용 전 공간으로 돌아가기',exact:true}).click();
    await wait(async()=>(await key(reader))===originalKey);assert.equal(await reader.evaluate(k=>localStorage.getItem(k),originalKey),original);
    await dialog.getByRole('button',{name:'공유 철회',exact:true}).click();
    await dialog.getByText('공유를 철회했습니다. 이미 복사한 설계도는 삭제되지 않습니다.',{exact:true}).waitFor();
    await reader.goto(url);await reader.getByRole('dialog').getByText('공유가 철회·만료되었거나 존재하지 않습니다.',{exact:true}).waitFor();
    assert.equal(await reader.getByRole('button',{name:'금액 확인 후 새 공간 만들기',exact:true}).isDisabled(),true);
    await dialog.getByRole('button',{name:`예시 설계도 ${width} 템플릿 삭제`,exact:true}).click();
    await dialog.getByText('템플릿과 공유를 삭제했습니다.',{exact:true}).waitFor();
    assert.equal((await fetch(api+'/template-shares/'+token)).status,404);assert.deepEqual(errors,[]);
    // A private saved template is usable without publishing it. The author
    // explicitly disconnects sync before switching to its new local profile.
    await dialog.getByLabel('템플릿 제목',{exact:true}).fill(`비공개 설계도 ${width}`);
    await dialog.getByRole('button',{name:'나만의 템플릿 저장',exact:true}).click();
    await dialog.getByRole('button',{name:'템플릿 수정 저장',exact:true}).waitFor();
    const authorSourceKey=await key(author), authorSource=await author.evaluate(k=>localStorage.getItem(k),authorSourceKey);
    await dialog.getByLabel('새 공간 월 수입 (원)',{exact:true}).fill('1000000');
    for(const item of body.blueprint.items) await dialog.getByLabel(item.name+' 실제 청구 금액 (원)',{exact:true}).fill('100');
    const ownApply=dialog.getByRole('button',{name:'금액 확인 후 새 공간 만들기',exact:true});assert.equal(await ownApply.isDisabled(),true);
    await dialog.getByLabel('새 공간을 만들면서 서버 연결을 해제합니다. 기존 서버 데이터는 변경하지 않습니다',{exact:true}).check();
    await ownApply.click();await dialog.waitFor({state:'hidden'});
    await wait(async()=>(await persisted(author)).fixedCosts.length===3);
    assert.equal(await author.evaluate(k=>localStorage.getItem(k),authorSourceKey),authorSource);
    assert.equal(await author.evaluate(()=>localStorage.getItem('living-cost-manager:server-session:v2')),null);
    assert.equal(await prisma.fixedCost.count({where:{workspaceId:fixture.workspace.id}}),0);
    assert.deepEqual(marketingWrites,[],'templates do not emit registration statistics even with reader consent ON');
    console.log(`PASS templates ${width}: 3 presets, own save/use, reviewed publication, anonymous preview, unset blocked, fresh IDs/profile, original bytes/return/reload, revoke/delete, explicit disconnect/no sync, consent-ON import telemetry0`);
  }
} catch(error) {
  console.error('Template browser page errors:',allErrors);
  if(evidence)for(const [i,c]of contexts.entries())for(const [j,page]of c.pages().entries())await page.screenshot({path:`${evidence}/failure-${i}-${j}.png`,animations:'disabled'}).catch(()=>{});
  throw error;
} finally {
  for(const c of contexts)await c.close();await browser.close();
  await prisma.user.delete({where:{id:fixture.user.id}});await prisma.workspace.delete({where:{id:fixture.workspace.id}}).catch(()=>{});await prisma.$disconnect();
  console.log('CLEANUP templates: synthetic account/workspace, browser contexts and DB client closed');
}
