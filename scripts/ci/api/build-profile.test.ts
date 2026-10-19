import {it,expect,afterEach,describe} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync,statSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {spawn,spawnSync} from 'node:child_process';
import {identity,lifecycle,watchChild,parseFree,inspectEvidence} from './build-profile.mjs';
import {GiB,REFERENCE,PUBLIC_BASES,RESERVES,estimate,admit,warmProofValid,sourceInventory} from './resource-budget.mjs';
import {MIGRATION} from './constants.mjs';
const roots:string[]=[];afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture() {
 const home=realpathSync(mkdtempSync(join(tmpdir(),'lcm-shared-')));roots.push(home);const workspace=join(home,'source');mkdirSync(join(workspace,'apps/api'),{recursive:true});
 const text='FROM node:24-alpine AS build\nRUN true\nFROM node:24-alpine AS runtime\n';writeFileSync(join(workspace,'apps/api/Dockerfile'),text);
 const env:any={GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'b'.repeat(40),GITHUB_REPOSITORY:'sanghyun-io/living-cost-manager',GITHUB_WORKFLOW_REF:'sanghyun-io/living-cost-manager/.github/workflows/ci.yml@refs/heads/main',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'push',GITHUB_ACTOR:'sanghyun-io',GITHUB_WORKSPACE:workspace,GITHUB_ENV:join(home,'github-env')};
 const id=identity(env),state:any={host:30*GiB,guest:20*GiB,current:'foreign-global-context',wrongHead:false,preexisting:['sha256:'+'f'.repeat(64)]},records=new Map<string,any>(),calls:any[]=[];
 const evidence:any={kind:'read-only-input-evidence',recipeKey:'9'.repeat(64),inventory:{kind:'actual-source-inventory',inputKey:'e'.repeat(64),packageKey:REFERENCE.packageKey,bytes:Buffer.byteLength(text),files:[{path:'apps/api/Dockerfile',bytes:Buffer.byteLength(text),sha256:hash(text)}]},baseDigest:PUBLIC_BASES.nodeDigest,baseCached:true,baseAccountingBytes:PUBLIC_BASES.nodeAccountingBytes,nodeVersion:PUBLIC_BASES.nodeVersion,pgCached:true,pgRef:PUBLIC_BASES.pgDigest,backend:'buildx existing fixture',sqlSha256:MIGRATION.sqlSha256};
 const run=(bin:string,a:string[])=>{
  calls.push({bin,args:a});
  if(bin==='git')return a.includes('rev-parse')?(state.wrongHead?'a'.repeat(40):id.sha):'';
  if(bin==='df'){if(state.badHost)throw Error('measurement');return `Filesystem blocks used available cap mount\n/dev/mock 99999999 1 ${Math.floor(state.host/1024)} 1% /System/Volumes/Data`;}
  if(bin==='colima'){expect(a).toEqual(['--profile','default','ssh','--','df','-Pk','/var/lib/docker']);if(state.badGuest)throw Error('measurement');return `Filesystem blocks used available cap mount\n/dev/vdb1 40000000 1 ${Math.floor(state.guest/1024)} 1% ${state.wrongMount?'/':'/var/lib/docker'}`;}
  if(bin!=='docker')throw Error('unexpected-command');expect(a.slice(0,2)).toEqual(['--context','colima']);const args=a.slice(2);
  if(args[0]==='context')return state.badEndpoint?'unix:///foreign.sock':`unix://${home}/.colima/default/docker.sock`;
  if(args[0]==='version')return state.badPlatform?'linux/amd64':'linux/arm64';
  if(args[0]==='info')return '/var/lib/docker';
  if(args[0]==='image'&&args.includes('--quiet'))return state.preexisting.join('\n');
  if(args.includes('ls')) {
   const filter=args[args.indexOf('--filter')+1];const kind=args[0];const name=filter?.startsWith('reference=')?filter.slice(10):filter?.replace(/^name=\^\/?/,'').replace(/\$$/,'');
   const x=records.get(kind+':'+name);if(!x)return '';return args.at(-1)==='{{.Size}}'?'641MB':name;
  }
  if(args[1]==='inspect')return JSON.stringify(records.get(args[0]+':'+args[2]));
  if(args[0]==='rm'||args[0]==='network'&&args[1]==='rm'||args[0]==='image'&&args[1]==='rm') {
   const target=args.at(-1);for(const [k,x]of records)if(k.endsWith(':'+target)||x.Id===target){records.delete(k);return '';}
   throw Error('foreign-remove');
  }
  throw Error('unexpected-mutation');
 };
 const watch=async(bin:string,a:string[],o:any)=>{calls.push({bin,args:a});o.check();if(state.drift)state.host=16.49*GiB;if(state.driftGuest)state.guest=2.49*GiB;if(state.childFails)throw Error('child');o.check();};
 const l=lifecycle({env,home,run,evidence,watch,report:()=>{}});
 const resource=(kind,name,extra={})=>{records.set(kind+':'+name,{Id:'sha256:'+hash(kind+name),...(kind==='image'?{Size:660000000,Os:'linux',Architecture:'arm64',Config:{Labels:{...l.labels,'org.opencontainers.image.revision':id.sha,'lcm-ci-input':evidence.inventory.inputKey,'moby.buildkit.cache.v0':'inline'}}}:{Labels:l.labels}),...extra});};
 return {home,workspace,env,id,state,records,calls,evidence,l,resource};
}
const mutations=f=>f.calls.filter(c=>c.bin==='docker'&&['rm','create','run','build','pull','prune'].some(s=>c.args.slice(2).includes(s)));
function warm(f) {
 const sourceSha='a'.repeat(40),run='11',attempt='1',tag=`lcm-ci-build-${run}-${attempt}-${sourceSha}:cache`;
 const labels={'org.opencontainers.image.revision':sourceSha,'lcm-ci-input':f.evidence.inventory.inputKey,'lcm-ci-run':run,'lcm-ci-attempt':attempt,'moby.buildkit.cache.v0':'inline'};
 f.records.set('image:'+tag,{Id:'sha256:'+'a'.repeat(64),Config:{Labels:labels}});
 const p={kind:'sampled-actual-not-atomic',status:'passed',syntheticHealth:true,repo:'sanghyun-io/living-cost-manager',sourceSha,run,attempt,inputKey:f.evidence.inventory.inputKey,recipeKey:f.evidence.recipeKey,baseDigest:f.evidence.baseDigest,backend:f.evidence.backend,nodeVersion:f.evidence.nodeVersion,sqlSha256:MIGRATION.sqlSha256,buildImageTag:tag,buildImageId:'sha256:'+'a'.repeat(64),outputs:{build:{bytes:660000000},runtime:{bytes:660000000}},archiveSha256:'d'.repeat(64),archiveBytes:REFERENCE.historicalArchiveBytes,samples:[{host:30*GiB,guest:20*GiB},{host:29*GiB,guest:19*GiB}]};
 mkdirSync(f.l.root,{recursive:true,mode:0o700});writeFileSync(join(f.l.root,`warm-${p.inputKey}.json`),JSON.stringify(p),{mode:0o600});return p;
}
describe('shared engine forecast/lease/owned cleanup',()=>{
 it('prepares without any VM lifecycle/context mutation; pins both Linux FROMs, preserves foreign resources',async()=>{
  const f=fixture();for(let i=0;i<21;i++)f.records.set('container:foreign-'+i,{Id:'foreign-'+i,Labels:{owner:'other'}});const before=JSON.stringify([...f.records]);
  await f.l.prepare();expect(mutations(f)).toEqual([]);expect(f.state.current).toBe('foreign-global-context');
  expect(readFileSync(join(f.l.job,'context/apps/api/Dockerfile'),'utf8').match(new RegExp(PUBLIC_BASES.nodeDigest,'g'))).toHaveLength(2);
  expect(statSync(f.l.job).mode&0o777).toBe(0o700);expect(statSync(f.l.leaseFile).mode&0o777).toBe(0o600);
  expect(readFileSync(f.env.GITHUB_ENV,'utf8')).toContain('LCM_BUILDER_CONTEXT=colima');
  f.l.teardown();f.l.teardown();expect(JSON.stringify([...f.records])).toBe(before);expect(f.calls.filter(c=>c.bin==='colima').every(c=>c.args[2]==='ssh')).toBe(true);
 });
 it('cold and warm forecasts are explicitly estimates, with physical floor once and distinct guest reserve',()=>{
  const f=fixture(),cold=estimate(f.evidence,false),cached=estimate(f.evidence,true);
  expect(cold.kind).toBe('estimate-from-caps-not-measurement');expect(cold.hostPeak).toBeGreaterThan(cached.hostPeak);
  expect(cold.syntheticPgCap).toBe(cold.parts.syntheticPG);expect(cold.syntheticPgCap).toBe(256*1024**2);
  expect(cold.hostRequired).toBe(16*GiB+Math.ceil(cold.hostPeak*1.2));expect(cold.guestRequired).toBe(2*GiB+Math.ceil(cold.guestPeak*1.2));
  expect(cold.hostPeak).toBe(Object.values(cold.parts).reduce((a:number,b:number)=>a+b,0));expect(cold.parts.streamedArchive).toBeGreaterThan(REFERENCE.historicalArchiveBytes);
 });
 it('uncached public bases increase the forecast, rather than claiming existing cache for unrelated du',()=>{
  const f=fixture(),a=estimate(f.evidence,false),b=estimate({...f.evidence,baseCached:false,pgCached:false,sharedCacheBytes:5*GiB},false);expect(b.hostPeak).toBeGreaterThan(a.hostPeak);expect(b.profile).toBe('cold-unverified-cache');
 });
 it.each(['cached','uncached','foreign-tag'])('read-only inspection %s distinguishes cache absence and public digest/config ID',mode=>{
  const calls:any[]=[];const run=(bin,a)=>{calls.push([bin,a]);if(bin==='git'){const r=spawnSync(bin,a,{encoding:'utf8'});expect(r.status).toBe(0);return r.stdout.trim();}
   expect(a.slice(0,2)).toEqual(['--context','colima']);if(a.includes('buildx'))return 'existing BuildKit fixture';if(a.includes('ls'))return mode==='uncached'?'':a.join(' ').includes('postgres')?'411MB':'238MB';
   if(a.includes('{{json .Config.Env}}'))return JSON.stringify(['NODE_VERSION=24.21.0']);
   return JSON.stringify(a.join(' ').includes('postgres')?{Id:'sha256:'+'2'.repeat(64),RepoDigests:[PUBLIC_BASES.pgDigest],Os:'linux',Architecture:'arm64'}:{Id:'sha256:'+'1'.repeat(64),Size:62065778,RepoDigests:mode==='foreign-tag'?[]:[PUBLIC_BASES.nodeDigest],Os:'linux',Architecture:'arm64'});
  };
  const root=resolve(import.meta.dirname,'../../..');
  if(mode==='foreign-tag'){expect(()=>inspectEvidence(root,run)).toThrow('base-identity');expect(calls.some(c=>c[1].includes('{{json .Config.Env}}'))).toBe(false);}
  else{const e=inspectEvidence(root,run);expect(e.baseCached).toBe(mode==='cached');expect(e.pgCached).toBe(mode==='cached');expect(e.baseDigest).toBe(PUBLIC_BASES.nodeDigest);if(mode==='cached')expect(e.baseId).not.toBe(e.baseDigest.slice(5));}
  expect(calls.filter(c=>c[0]==='docker').every(c=>!c[1].some(x=>['pull','build','prune','rm'].includes(x)))).toBe(true);
 });
 it.each(['host','guest','badHost','badGuest','wrongMount','badEndpoint','badPlatform'])('bad/insufficient %s blocks before any mutation',async field=>{
  const f=fixture();if(field==='host')f.state.host=19.5*GiB;else if(field==='guest')f.state.guest=7.5*GiB;else f.state[field]=true;
  await expect(f.l.prepare()).rejects.toThrow();expect(mutations(f)).toEqual([]);
 });
 it('missing native BuildKit blocks; never installs a tool or falls back to legacy cancellation assumptions',async()=>{
  const f=fixture();f.evidence.backend=null;await expect(f.l.prepare()).rejects.toThrow('native-buildkit');expect(mutations(f)).toEqual([]);expect(existsSync(f.l.job)).toBe(false);
 });
 it('verified same-input warm proof is required; losing its live cache falls back to the full cold forecast',async()=>{
  const f=fixture(),p=warm(f);f.state.host=20*GiB;f.state.guest=7.5*GiB;await f.l.prepare();expect(f.l.owned().plan.profile).toBe('verified-identical-input-cache');
  f.records.delete('image:'+p.buildImageTag);expect(()=>f.l.capacity()).toThrow('capacity-budget');expect(f.l.owned().plan.profile).toBe('cold-unverified-cache');expect(mutations(f)).toEqual([]);
 });
 it.each(['status','inputKey','recipeKey','baseDigest','sqlSha256','buildImageId','sourceSha','run','buildImageTag'])('warm proof %s mismatch does not grant credit',field=>{
  const f=fixture(),p=warm(f),live=f.records.get('image:'+p.buildImageTag);expect(warmProofValid(p,f.evidence,live)).toBe(true);expect(warmProofValid({...p,[field]:'wrong'},f.evidence,live)).toBe(false);
 });
 it('DNS-safe names include run/attempt/digest and FULL SHA labels; foreign collision is refused before remove',async()=>{
  const f=fixture();await f.l.prepare();for(const n of Object.values(f.l.names)){expect(n).toContain(`${f.id.run}-${f.id.attempt}-${f.id.sha.slice(0,12)}`);expect(n.length).toBeLessThan(63);}expect(f.l.labels['lcm-ci-owner']).toBe(f.id.sha);
  f.resource('container',f.l.names.pg,{Labels:{'lcm-ci-owner':'other'}});expect(()=>f.l.intent('container',f.l.names.pg)).toThrow('foreign-preexisting');expect(mutations(f)).toEqual([]);
 });
 it('phase-scoped probe intents never reuse a removed probe, allow separate phases, and reject out-of-range ordinals',async()=>{
  const f=fixture();await f.l.prepare();const first=f.l.names.probe+'-baseline-1';f.l.intent('container',first);
  expect(()=>f.l.intent('container',first)).toThrow('resource-reuse');f.l.intent('container',f.l.names.probe+'-build-1');
  for(const suffix of ['baseline-0','baseline-11','baseline-9007199254740992','baseline-NaN','other-1'])expect(()=>f.l.intent('container',f.l.names.probe+'-'+suffix)).toThrow('resource-name');
  const foreign=f.l.names.probe+'-synthetic-2';f.resource('container',foreign,{Labels:{owner:'other'}});expect(()=>f.l.intent('container',foreign)).toThrow('foreign-preexisting');expect(mutations(f)).toEqual([]);
 });
 it.each(['lcm-ci-owner','lcm-ci-run','lcm-ci-attempt'])('cleanup refuses foreign/mismatched %s and keeps the resource',async key=>{
  const f=fixture();await f.l.prepare();f.l.intent('container',f.l.names.pg);f.resource('container',f.l.names.pg,{Labels:{...f.l.labels,[key]:'other'}});
  expect(()=>f.l.teardown()).toThrow('cleanup-incomplete');expect(f.records.has('container:'+f.l.names.pg)).toBe(true);expect(mutations(f)).toEqual([]);
 });
 it('newly tagged preexisting untagged image ID is NOT deleted even with matching job labels',async()=>{
  const f=fixture();await f.l.prepare();f.l.intent('image',f.l.tags.runtime);f.resource('image',f.l.tags.runtime,{Id:f.state.preexisting[0]});
  expect(()=>f.l.teardown()).toThrow('cleanup-incomplete');expect(f.records.has('image:'+f.l.tags.runtime)).toBe(true);expect(mutations(f)).toEqual([]);
 });
 it('cleanup uses only recorded fresh immutable container IDs and exact owned image tags; retains reviewed cache',async()=>{
  const f=fixture();await f.l.prepare();f.l.intent('container',f.l.names.pg);f.resource('container',f.l.names.pg);const id=f.l.check('container',f.l.names.pg);
  f.l.intent('image',f.l.tags.build);f.resource('image',f.l.tags.build);const j=f.l.owned();j.keepBuildCache=true;writeFileSync(f.l.leaseFile,JSON.stringify(j),{mode:0o600});
  f.l.teardown();expect(f.records.has('container:'+f.l.names.pg)).toBe(false);expect(f.records.has('image:'+f.l.tags.build)).toBe(true);expect(mutations(f).map(c=>c.args.at(-1))).toEqual([id]);
 });
 it('remaining-stage admission uses fresh df with persisted outputs already occupying disk (no peak reset)',async()=>{
  const f=fixture();await f.l.prepare();const initial=f.l.capacity();f.l.done('linux-build');f.state.host=24*GiB;const next=f.l.capacity();expect(next.hostRequired).toBeLessThan(initial.hostRequired);expect(next.host).toBe(24*GiB);expect(next.hostRequired).toBeGreaterThan(16*GiB);
 });
 it.each(['drift','driftGuest','childFails'])('monitor %s aborts only own operation; measurements never become passed',async field=>{
  const f=fixture();await f.l.prepare();f.state[field]=true;await expect(f.l.runImage(['build','--sha',f.id.sha])).rejects.toThrow('image-halted');
  const m=JSON.parse(readFileSync(join(f.l.job,'measurement.json'),'utf8'));expect(m.kind).toBe('sampled-actual-not-atomic');expect(m.status).toBe('failed-or-cancelled');expect(m.sharedObservedDelta).toBeDefined();expect(f.l.owned().stage).toBe('cleaned');
 });
 it('absence of full health/archive stages cannot fabricate a completed measurement',async()=>{const f=fixture();await f.l.prepare();expect(()=>f.l.completeProof()).toThrow('measurement-incomplete');});
 it('invalid immutable SHA and routing overrides fail without selecting an engine',()=>{
  const f=fixture();for(const extra of [{GITHUB_SHA:'HEAD'},{GITHUB_RUN_ID:'1;bad'},{DOCKER_CONTEXT:'other'},{LCM_BUILDER_CONTEXT:'default'},{LCM_BUILDER_PROFILE:'default'},{GITHUB_ACTOR:'other'}])expect(()=>lifecycle({env:{...f.env,...extra},home:f.home})).toThrow();
 });
 it('atomic active lease refuses concurrent job; exact source mismatch fails before mutation',async()=>{
  const f=fixture();f.state.wrongHead=true;await expect(f.l.prepare()).rejects.toThrow('source-identity');f.state.wrongHead=false;await f.l.prepare();await expect(f.l.prepare()).rejects.toThrow();expect(mutations(f)).toEqual([]);
 });
 it('actual DockerRootDir parser rejects VM root, zero and malformed outputs',()=>{
  expect(parseFree('fs blocks used available cap mount\n/dev/vdb1 40000000 1 7837492 1% /var/lib/docker','/var/lib/docker')).toBe(7837492*1024);
  for(const s of ['invalid','fs blocks used available cap mount\n/dev/vda1 20000000 1 19000000 1% /','fs blocks used available cap mount\n/dev/vdb1 40000000 1 0 1% /var/lib/docker'])expect(()=>parseFree(s,'/var/lib/docker')).toThrow();
  expect(()=>admit(estimate(fixture().evidence),{host:NaN,guest:20*GiB})).toThrow('capacity-unknown');expect(RESERVES.physicalFloor).toBe(15*GiB);
 });
 it('stale package reference blocks rather than silently using a smaller magic peak',()=>{const f=fixture();expect(()=>estimate({...f.evidence,inventory:{...f.evidence.inventory,packageKey:'other'}})).toThrow('reference-stale');});
 it('source allowlist excludes private/untracked env and rejects source symlinks and oversized context',()=>{
  const f=fixture(),paths=['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','apps/api/package.json','apps/web/package.json','packages/shared/package.json','apps/api/Dockerfile'];
  for(const p of paths){mkdirSync(join(f.workspace,p,'..'),{recursive:true});if(!existsSync(join(f.workspace,p)))writeFileSync(join(f.workspace,p),'{}');}
  writeFileSync(join(f.workspace,'.env'),'PRIVATE_SYNTHETIC_SENTINEL');const inv=sourceInventory(f.workspace,[...paths,'.env']);expect(inv.files.some(x=>x.path==='.env')).toBe(false);
  mkdirSync(join(f.workspace,'apps/api/src'));symlinkSync(join(f.workspace,'.env'),join(f.workspace,'apps/api/src/link.ts'));expect(()=>sourceInventory(f.workspace,[...paths,'apps/api/src/link.ts'])).toThrow('input-type');
  writeFileSync(join(f.workspace,'apps/api/src/large.ts'),Buffer.alloc(4*1024**2));expect(()=>sourceInventory(f.workspace,[...paths,'apps/api/src/large.ts'])).toThrow('context-cap');
 });
 it.each([NaN,0,9*GiB])('candidate accounting %s fails without releasing the next stage budget',async size=>{
  const f=fixture();await f.l.prepare();f.l.intent('image',f.l.tags.runtime);f.resource('image',f.l.tags.runtime,{Size:size});expect(()=>f.l.recordOutput('runtime')).toThrow();expect(f.l.owned().completed).not.toContain('runtime');
 });
});
it('real process monitor terminates only its detached child group; unrelated child remains alive',async()=>{
 const p=realpathSync(mkdtempSync(join(tmpdir(),'lcm-monitor-')));roots.push(p);let n=0,ownPid;
 const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 try{await expect(watchChild(process.execPath,['-e','process.stderr.write("PRIVATE_CHILD");setInterval(()=>{},1000)'],{check:()=>{if(++n>2)throw Error('budget');},interval:50,log:join(p,'private.log'),onSpawn:c=>ownPid=c.pid})).rejects.toThrow('owned-child-halted');expect(other.exitCode).toBe(null);expect(()=>process.kill(other.pid!,0)).not.toThrow();expect(()=>process.kill(ownPid,0)).toThrow();expect(statSync(join(p,'private.log')).mode&0o777).toBe(0o600);}finally{const done=new Promise(r=>other.once('exit',r));other.kill('SIGTERM');await done;}
},10000);
it('controller cancellation sends cancellation to its own child group and fails, never reports completed measurement',async()=>{
 const p=realpathSync(mkdtempSync(join(tmpdir(),'lcm-cancel-')));roots.push(p);const pid=join(p,'pid'),url=new URL('./build-profile.mjs',import.meta.url).href;
 const script=`import{watchChild}from${JSON.stringify(url)};import{writeFileSync}from'node:fs';try{await watchChild(process.execPath,['-e','setInterval(()=>{},1000)'],{check:()=>{},interval:20,log:${JSON.stringify(join(p,'private.log'))},onSpawn:c=>writeFileSync(${JSON.stringify(pid)},String(c.pid))});}catch{process.exitCode=1;}`;
 const c=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});
 try{for(let i=0;i<100&&!existsSync(pid);i++)await new Promise(r=>setTimeout(r,10));expect(existsSync(pid)).toBe(true);const child=+readFileSync(pid,'utf8');const ended=new Promise(r=>c.once('exit',r));c.kill('SIGTERM');expect(await ended).toBe(1);expect(()=>process.kill(child,0)).toThrow();}finally{if(c.exitCode===null&&c.signalCode===null){const ended=new Promise(r=>c.once('exit',r));c.kill('SIGTERM');await ended;}}
},10000);
