import{it,expect,afterEach}from'vitest';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync,copyFileSync,statSync}from'node:fs';
import{join,dirname,resolve}from'node:path';import{tmpdir}from'node:os';import{spawnSync}from'node:child_process';import{pathToFileURL}from'node:url';
import{BASE,compatibility,inventory,canonical,sha}from'./runtime-overlay.mjs';import{lifecycle}from'./build-profile.mjs';import{MIGRATION}from'./constants.mjs';
const HERE=import.meta.dirname,ROOT=resolve(HERE,'../../..'),ENGINE=join(HERE,'tests/overlay-cli-engine.mjs'),roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
async function fixture(mode='normal',prebuilt=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lcm-overlay-cli-')));roots.push(root);const home=join(root,'home'),bin=join(root,'bin'),payload=join(root,'bundle');for(const p of [home,bin,payload])mkdirSync(p,{mode:0o700});
 const env:any={...process.env,HOME:home,GITHUB_WORKSPACE:ROOT,GITHUB_REPOSITORY:'sanghyun-io/living-cost-manager',GITHUB_WORKFLOW_REF:'sanghyun-io/living-cost-manager/.github/workflows/ci.yml@refs/heads/main',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'push',GITHUB_ACTOR:'sanghyun-io',GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_ENV:join(root,'github-env'),GITHUB_ACTIONS:'false',LCM_BUILDER_CONTEXT:'colima',LCM_EXPECTED_BUILD_KIND:'runtime-overlay',LCM_CLI_FIXTURE:root};
 for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','COLIMA_HOME','COLIMA_PROFILE','LIMA_HOME','LCM_BUILDER_PROFILE'])delete env[k];
 const proof=compatibility(ROOT);const put=(p,b)=>{mkdirSync(dirname(join(payload,p)),{recursive:true,mode:0o700});writeFileSync(join(payload,p),b);};
 put('api/dist/server.js','// synthetic compiled fixture, not a runtime build\n');put('shared/dist/index.js','// synthetic compiled shared fixture\n');
 for(const [from,to]of [['apps/api/package.json','api/package.json'],['packages/shared/package.json','shared/package.json'],['prisma/schema.prisma','prisma/schema.prisma'],[MIGRATION.dir+'/migration.sql',MIGRATION.dir+'/migration.sql'],['scripts/ci/api/Dockerfile.runtime-overlay','Dockerfile'],['scripts/ci/api/runtime-overlay.cjs','tools/runtime-overlay.cjs']])put(to,readFileSync(join(ROOT,from)));
 const manifest:any={schema:'lcm-compiled-overlay-v1',repo:env.GITHUB_REPOSITORY,source:env.GITHUB_SHA,run:'123',attempt:'1',dependencyProof:proof,...inventory(payload)};manifest.bundleSha256=sha(canonical(manifest));writeFileSync(join(payload,'bundle.json'),JSON.stringify(manifest));
 const base:any={imageId:BASE.imageId,imageBytes:150971118,accountingBytes:635000000,platform:BASE.platform,source:BASE.source,envNames:['PATH','NODE_VERSION','YARN_VERSION','RELEASE_SHA','NODE_ENV'],forSource:env.GITHUB_SHA,run:'123',attempt:'1',auditSha256:sha(readFileSync(join(payload,'tools/runtime-overlay.cjs'))),archiveBytes:null,archiveSha256:null,audit:{node:BASE.node,nodeMajor:24,abi:'137',platform:BASE.platform,prisma:'6.19.3',safety:true,sharedPath:'/app/node_modules/.pnpm/shared/node_modules/@living-cost-manager/shared',generatedBytes:20199170,generatedFiles:18,apiCore:proof.apiCore,sharedCore:proof.sharedCore}};
 const bytes=Buffer.from('synthetic immutable code-only base image\n');writeFileSync(join(root,'base-code.bin'),bytes);
 const clientDir=join(home,'.local/state/lcm-api-shared-build',`123-1-${env.GITHUB_SHA}`,'client');
 const foreign={Id:'foreign-container-id',Labels:{owner:'other-product'}};
 const baseImage={Id:BASE.imageId,Size:base.imageBytes,Os:'linux',Architecture:'arm64',Config:{Labels:{'org.opencontainers.image.revision':BASE.source}}};
 const control:any={mode,home,clientDir,baseImage,nativeGcReserve:6135360783,transport:{...base,archiveBytes:bytes.length,archiveSha256:sha(bytes)},remoteRoot:join(root,'remote')};writeFileSync(join(root,'control.json'),JSON.stringify(control));
 writeFileSync(join(root,'engine.json'),JSON.stringify({image:{'foreign-image':{Id:'foreign-image-id',Config:{Labels:{owner:'other'}}}},container:{'foreign-container':foreign},network:{'foreign-network':{Id:'foreign-network-id',Labels:{owner:'other'}}}}));
 for(const name of ['docker','df','colima','ssh'])writeFileSync(join(bin,name),`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ENGINE)} ${name} "$@"\n`,{mode:0o700});
 const server=join(control.remoteRoot,'backups',`actions-123-1-${env.GITHUB_SHA.slice(0,12)}`,'deploy-host.sh');mkdirSync(dirname(server),{recursive:true});writeFileSync(server,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ENGINE)} server "$@"\n`,{mode:0o700});writeFileSync(join(bin,'sudo'),'#!/bin/sh\nexec "$@"\n',{mode:0o700});
 env.PATH=bin+':'+process.env.PATH;env.LCM_SSH_BIN=join(bin,'ssh');env.NODE_OPTIONS=`--import=${pathToFileURL(join(HERE,'tests/overlay-cli-preload.mjs')).href}`;
 const run=(b,a)=>{if(b==='git')return a.includes('rev-parse')?env.GITHUB_SHA:'';const r=spawnSync(join(bin,b),a,{env,encoding:'utf8'});if(r.status!==0)throw Error('fixture-preparation-command');return r.stdout.trim();};
 const clientFactory=(dir,opts)=>{if(opts.create)mkdirSync(dir,{mode:0o700});return {prefix:['--config',dir,'--context','colima'],env,backend:'fixture-native-Buildx',nativeGcReserve:control.nativeGcReserve,call:a=>run('docker',['--config',dir,'--context','colima',...a])};};
 const l=lifecycle({env,home,run,clientFactory,report:()=>{}}),baseFile=join(root,'inspection.json');writeFileSync(baseFile,JSON.stringify(base));await l.prepareOverlay(payload,baseFile);
 if(prebuilt){const state=JSON.parse(readFileSync(join(root,'engine.json'),'utf8'));state.image[l.tags.runtime]={Id:'sha256:'+'c'.repeat(64),Size:160000000,Os:'linux',Architecture:'arm64',Config:{Labels:{...l.labels,'org.opencontainers.image.revision':env.GITHUB_SHA}}};writeFileSync(join(root,'engine.json'),JSON.stringify(state));const j=l.owned();j.completed=['baseline','runtime'];j.resources.push({kind:'image',name:l.tags.runtime,baselineAbsent:true});j.outputs={runtime:{bytes:640000000}};writeFileSync(l.leaseFile,JSON.stringify(j),{mode:0o600});}
 const cli=(op,more=[])=>spawnSync(process.execPath,[join(HERE,'image.mjs'),op,'--sha',env.GITHUB_SHA,...more],{cwd:ROOT,env,encoding:'utf8',timeout:20000});
 const commands=()=>readFileSync(join(root,'commands.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 const diagnostic=()=>{const p=join(l.job,'private.log'),s=existsSync(p)?readFileSync(p,'utf8'):'';return s.includes('resource-reuse')?'actual handler: resource-reuse':s.includes("reading 'syntheticPG'")?'actual handler: TypeError reading syntheticPG':'no fixed handler error captured';};
 return {root,env,l,cli,commands,foreign,manifest,diagnostic};
}
it('whole overlay CLI sequence shares ONE lease and fake engine across baseline → build → synthetic → archive',async()=>{
 const f=await fixture();const pids=[];
 for(const op of ['baseline','build','synthetic','archive']){const args=op==='archive'?['--out',join(f.root,'image.tar.gz'),'--metadata',join(f.root,'metadata.json')]:[];const r=f.cli(op,args);expect(r.status,`${op}: ${r.stdout}${r.stderr} ${f.diagnostic()}`).toBe(0);pids.push(r.pid);}
 expect(new Set(pids).size).toBe(4);
 const j=JSON.parse(readFileSync(f.l.leaseFile,'utf8'));expect(j.completed).toEqual(['baseline','runtime','synthetic','archive']);
 const probes=f.commands().filter(x=>x.mode==='container-created'&&x.name.startsWith(f.l.names.probe+'-'));expect(probes.length).toBe(6);expect(new Set(probes.map(x=>x.name)).size).toBe(probes.length);
 for(const p of probes)expect(p.labels).toMatchObject(f.l.labels);
 const m=JSON.parse(readFileSync(join(f.l.job,'measurement.json'),'utf8'));expect(m.status).toBe('passed');expect(m.kind).toBe('sampled-actual-not-atomic');expect(m.samples.some(x=>x.stage==='baseline')).toBe(true);expect(m.requestedIntervalMs).toBe(500);
 const meta=JSON.parse(readFileSync(join(f.root,'metadata.json'),'utf8'));expect(meta.sha).toBe(f.env.GITHUB_SHA);expect(meta.runId).toBe('123');expect(meta.runAttempt).toBe('1');expect(meta.bundleSha256).toBe(f.manifest.bundleSha256);
 const verify=f.cli('verify-archive',['--archive',join(f.root,'image.tar.gz'),'--metadata',join(f.root,'metadata.json')]);expect(verify.status).toBe(0);
 f.l.teardown();const state=JSON.parse(readFileSync(join(f.root,'engine.json'),'utf8'));expect(state.container).toEqual({'foreign-container':f.foreign});expect(Object.keys(state.network)).toEqual(['foreign-network']);expect(state.image['foreign-image'].Id).toBe('foreign-image-id');
},30000);
it('overlay synthetic CLI reaches the real PG footprint/cap/cleanup handler from a valid prebuilt candidate fixture',async()=>{
 const f=await fixture('normal',true);const r=f.cli('synthetic');expect(r.status,r.stdout+r.stderr+' '+f.diagnostic()).toBe(0);expect(r.stdout).toContain('monitored operation ok');
 const j=JSON.parse(readFileSync(f.l.leaseFile,'utf8'));expect(j.completed).toContain('synthetic');expect(f.commands().some(x=>x.mode==='docker'&&x.args.includes('du'))).toBe(true);
 const s=JSON.parse(readFileSync(join(f.root,'engine.json'),'utf8'));expect(s.planningSmoke.revision).toBe(2);expect(s.container).toEqual({'foreign-container':f.foreign});f.l.teardown();
},20000);
it('direct baseline worker flag cannot bypass the leased controller before any export/import',async()=>{const f=await fixture();const r=f.cli('baseline',['--profile-worker']);expect(r.status).toBe(1);expect(f.commands().some(x=>x.mode==='server'||x.mode==='docker'&&x.args[0]==='load')).toBe(false);f.l.teardown();},20000);
it('actual build handler failure preserves Docker stderr privately and reports only operation/status publicly',async()=>{
 const f=await fixture('build-error');expect(f.cli('baseline').status).toBe(0);const r=f.cli('build');expect(r.status).toBe(1);
 expect(r.stderr).toContain('operation=overlay-build child-exit=1 diagnostics=protected');expect(r.stdout+r.stderr).not.toContain('PRIVATE_BUILD_STDERR_SENTINEL');
 const p=join(f.l.job,'code-child.log');expect(readFileSync(p,'utf8')).toContain('PRIVATE_BUILD_STDERR_SENTINEL');expect(statSync(p).mode&0o777).toBe(0o600);expect(statSync(join(f.l.job,'child-failure.json')).mode&0o777).toBe(0o600);
 const j=JSON.parse(readFileSync(f.l.leaseFile,'utf8'));expect(j.completed).toEqual(['baseline']);expect(j.stage).toBe('cleaned');expect(JSON.parse(readFileSync(join(f.l.job,'measurement.json'),'utf8')).status).not.toBe('passed');
},20000);
it('overlay PG over-cap remains a failed gate and cleans only its labelled synthetic resources',async()=>{
 const f=await fixture('pg-overcap',true),r=f.cli('synthetic');expect(r.status).toBe(1);expect(f.commands().some(x=>x.mode==='docker'&&x.args.includes('du'))).toBe(true);
 const j=JSON.parse(readFileSync(f.l.leaseFile,'utf8'));expect(j.completed).not.toContain('synthetic');expect(j.stage).toBe('cleaned');const m=JSON.parse(readFileSync(join(f.l.job,'measurement.json'),'utf8'));expect(m.status).not.toBe('passed');expect(JSON.parse(readFileSync(join(f.root,'engine.json'),'utf8')).container).toEqual({'foreign-container':f.foreign});
},20000);
it.each(['transfer-dip','load-dip'])('baseline %s is actually monitored, cancels OWN child and leaves no partial local image input/success',async mode=>{
 const f=await fixture(mode);const r=f.cli('baseline');expect(r.status,r.stdout+r.stderr).toBe(1);
 const m=JSON.parse(readFileSync(join(f.l.job,'measurement.json'),'utf8'));expect(m.status).toBe('failed-or-cancelled');expect(m.samples.some(x=>x.stage==='baseline')).toBe(true);expect(m.requestedIntervalMs).toBe(500);
 expect(existsSync(join(f.root,mode==='transfer-dip'?'ssh-stopped':'load-stopped'))).toBe(true);expect(existsSync(join(f.l.job,'scratch/base-import/base.tar.gz'))).toBe(false);
 const j=JSON.parse(readFileSync(f.l.leaseFile,'utf8'));expect(j.stage).toBe('cleaned');expect(j.completed).not.toContain('baseline');expect(j.completed).not.toContain('archive');expect(f.commands().some(x=>x.mode==='docker'&&x.args[0]==='buildx')).toBe(false);
 expect(f.cli('build').status).toBe(1);expect(f.cli('archive',['--out',join(f.root,'must-not-exist.tar.gz'),'--metadata',join(f.root,'must-not-exist.json')]).status).toBe(1);expect(existsSync(join(f.root,'must-not-exist.tar.gz'))).toBe(false);expect(existsSync(join(f.root,'must-not-exist.json'))).toBe(false);
 const state=JSON.parse(readFileSync(join(f.root,'engine.json'),'utf8'));expect(state.container).toEqual({'foreign-container':f.foreign});expect(state.image['foreign-image'].Id).toBe('foreign-image-id');
},20000);
