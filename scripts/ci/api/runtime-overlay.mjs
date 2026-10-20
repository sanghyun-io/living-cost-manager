import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,copyFileSync,existsSync} from 'node:fs';
import {join,dirname,resolve,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROD,MIGRATION,REPO} from './constants.mjs';
import {identity} from './build-profile.mjs';
import {GiB,MiB,RESERVES,SYNTHETIC_PG_CAP} from './resource-budget.mjs';
// Immutable dependency donor, NOT the currently serving image or rollback target.
export const BASE=Object.freeze({source:'a2c7bd9af46d84dc88b2a36656c25949b57076b0',imageId:'sha256:5d133132b544a0d5b07d471dab7e4a8a1dfb51d491be12ab7c7bb36c14ce667f',node:'v24.19.0',nodeMajor:24,abi:'137',prisma:'6.19.3',platform:'linux/arm64'});
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const canonical=x=>JSON.stringify(x&&typeof x==='object'?Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])):x);
export const core=p=>Object.fromEntries(['name','version','type','main','types','exports'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));
export function yaml(text) {const r=spawnSync('ruby',['-ryaml','-rjson','-e','puts JSON.generate(YAML.safe_load(STDIN.read, permitted_classes: [], aliases: false))'],{input:text,encoding:'utf8'});if(r.status!==0)throw Error('lock-parse');return JSON.parse(r.stdout);}
export function compareDependencies(base,current) {
 for(const p of ['package.json','apps/api/package.json','packages/shared/package.json'])if(canonical(base[p])!==canonical(current[p]))throw Error('runtime-manifest-changed');
 const old=structuredClone(base.lock),now=structuredClone(current.lock),extra=now.importers?.['apps/web']?.devDependencies?.esbuild;
 if(!old.importers?.['apps/web']?.devDependencies?.esbuild&&extra!==undefined){if(canonical(extra)!==canonical({specifier:'0.28.0',version:'0.28.0'}))throw Error('unapproved-web-dev-lock-change');delete now.importers['apps/web'].devDependencies.esbuild;}
 if(canonical(old)!==canonical(now))throw Error('runtime-lock-changed');
 const queue=['.','apps/api','packages/shared'],seen=new Set();
 while(queue.length){const p=queue.shift();if(seen.has(p))continue;seen.add(p);if(p==='apps/web')throw Error('api-reaches-web');
  for(const [name,v]of Object.entries({...now.importers?.[p]?.dependencies,...now.importers?.[p]?.optionalDependencies})){if(name==='@living-cost-manager/web')throw Error('api-reaches-web');const ver=typeof v==='object'?v.version:v;if(typeof ver==='string'&&ver.startsWith('link:'))queue.push(posix.normalize(posix.join(p,ver.slice(5))));}
 }
 const pkgs=Object.fromEntries(['package.json','apps/api/package.json','packages/shared/package.json'].map(p=>[p,sha(canonical(base[p]))]));
 const proof={baselineSource:BASE.source,baselineImageId:BASE.imageId,platform:BASE.platform,nodeMajor:BASE.nodeMajor,abi:BASE.abi,prisma:BASE.prisma,packageHashes:pkgs,normalizedLockSha256:sha(canonical(old)),apiCore:core(current['apps/api/package.json']),sharedCore:core(current['packages/shared/package.json'])};
 return {...proof,sha256:sha(canonical(proof))};
}
export function compatibility(root,git=(p)=>{const r=spawnSync('git',['-C',root,'show',`${BASE.source}:${p}`],{encoding:'utf8'});if(r.status!==0)throw Error('baseline-source-unavailable');return r.stdout;}) {
 const b={},c={};for(const p of ['package.json','apps/api/package.json','packages/shared/package.json']){b[p]=JSON.parse(git(p));c[p]=JSON.parse(readFileSync(join(root,p),'utf8'));}b.lock=yaml(git('pnpm-lock.yaml'));c.lock=yaml(readFileSync(join(root,'pnpm-lock.yaml'),'utf8'));return compareDependencies(b,c);
}
export function safePath(p) {return typeof p==='string'&&p.length>0&&!p.startsWith('/')&&!/[\x00-\x1f\\]/.test(p)&&!p.split('/').some(s=>!s||s==='.'||s==='..'||s==='node_modules'||s.startsWith('.env')||/\.(dump|sqlite|db)$/.test(s))&&(/^(api\/dist|shared\/dist)\/.+\.(js|json|map|ts)$/.test(p)||/^prisma\/.+\.(prisma|sql|toml)$/.test(p)||['api/package.json','shared/package.json','Dockerfile','tools/runtime-overlay.cjs'].includes(p));}
export function inventory(root) {
 const files=[];function walk(dir,prefix=''){for(const d of readdirSync(dir,{withFileTypes:true})){const p=prefix?prefix+'/'+d.name:d.name;if(p==='bundle.json')continue;const f=join(dir,d.name),s=lstatSync(f);if(s.isSymbolicLink())throw Error('bundle-symlink');if(s.isDirectory())walk(f,p);else{if(!s.isFile()||!safePath(p)||s.size>4*MiB)throw Error('bundle-path');files.push({path:p,bytes:s.size,sha256:sha(readFileSync(f))});}}}walk(root);files.sort((a,b)=>a.path.localeCompare(b.path));const bytes=files.reduce((n,f)=>n+f.bytes,0);if(!files.length||files.length>1024||bytes>4*MiB)throw Error('bundle-cap');return {files,bytes};
}
export function bundle(root,out,env=process.env) {
 const id=identity(env),r=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'});if(r.status!==0||r.stdout.trim()!==id.sha)throw Error('bundle-source');
 const proof=compatibility(root);mkdirSync(out,{mode:0o700});
 function copy(src,dest){const s=lstatSync(src);if(s.isSymbolicLink())throw Error('bundle-symlink');if(s.isDirectory()){mkdirSync(dest,{recursive:true,mode:0o700});for(const n of readdirSync(src))copy(join(src,n),join(dest,n));}else{mkdirSync(dirname(dest),{recursive:true,mode:0o700});copyFileSync(src,dest);}}
 for(const [a,b]of [['apps/api/dist','api/dist'],['packages/shared/dist','shared/dist'],['prisma','prisma'],['apps/api/package.json','api/package.json'],['packages/shared/package.json','shared/package.json'],['scripts/ci/api/runtime-overlay.cjs','tools/runtime-overlay.cjs'],['scripts/ci/api/Dockerfile.runtime-overlay','Dockerfile']])copy(join(root,a),join(out,b));
 const inv=inventory(out),m={schema:'lcm-compiled-overlay-v1',repo:REPO,source:id.sha,run:id.run,attempt:id.attempt,dependencyProof:proof,...inv};m.bundleSha256=sha(canonical(m));writeFileSync(join(out,'bundle.json'),JSON.stringify(m),{mode:0o600});return m;
}
export function verifyBundle(root,env=process.env,expectedProof) {
 const id=identity(env),m=JSON.parse(readFileSync(join(root,'bundle.json'),'utf8')),saved=m.bundleSha256;delete m.bundleSha256;
 if(m.schema!=='lcm-compiled-overlay-v1'||m.repo!==REPO||m.source!==id.sha||m.run!==id.run||m.attempt!==id.attempt||sha(canonical(m))!==saved||expectedProof&&canonical(m.dependencyProof)!==canonical(expectedProof))throw Error('bundle-binding');
 const actual=inventory(root);if(canonical(actual.files)!==canonical(m.files)||actual.bytes!==m.bytes||!m.files.some(f=>f.path==='api/dist/server.js')||!m.files.some(f=>f.path==='shared/dist/index.js')||!m.files.some(f=>f.path==='prisma/schema.prisma'))throw Error('bundle-integrity');
 if(sha(readFileSync(join(root,MIGRATION.dir,'migration.sql')))!==MIGRATION.sqlSha256)throw Error('bundle-sql');
 return {...m,bundleSha256:saved};
}
export function verifyBase(m,transport=true) {
 const allowed=['PATH','NODE_VERSION','YARN_VERSION','RELEASE_SHA','NODE_ENV'];
 if(m.imageId!==BASE.imageId||m.source!==BASE.source||m.platform!==BASE.platform||!Number.isSafeInteger(m.imageBytes)||m.imageBytes<=0||!Number.isSafeInteger(m.accountingBytes)||m.accountingBytes<m.imageBytes||m.accountingBytes>GiB||!Array.isArray(m.envNames)||m.envNames.some(k=>!allowed.includes(k)))throw Error('baseline-image-identity');
 const a=m.audit;if(!a||a.node!==BASE.node||a.nodeMajor!==24||a.abi!=='137'||a.platform!==BASE.platform||a.prisma!==BASE.prisma||a.safety!==true||!Number.isSafeInteger(a.generatedBytes)||a.generatedBytes<=0||a.generatedBytes>64*MiB||!a.sharedPath?.startsWith('/app/node_modules/')||posix.normalize(a.sharedPath)!==a.sharedPath||!a.apiCore||!a.sharedCore||!/^[a-f0-9]{64}$/.test(m.auditSha256??''))throw Error('baseline-safety-or-version');
 if(transport&&(!Number.isSafeInteger(m.archiveBytes)||m.archiveBytes<=0||m.archiveBytes>Math.ceil(m.accountingBytes*1.1)||!/^[a-f0-9]{64}$/.test(m.archiveSha256??'')))throw Error('baseline-archive');return m;
}
export function overlayEstimate(m,bundle,localBase=false,pgCached=true,nativeGcReserve=null) {
 verifyBase(m,false);const B=m.accountingBytes,C=m.imageBytes,A=m.archiveBytes??Math.ceil(B*1.1),delta=Math.ceil((bundle.bytes*2+m.audit.generatedBytes*2)/MiB)*MiB;
 const metadata=32*MiB,importGuest=localBase?0:B*2+C;
 const retained=localBase?0:B+C,pgResident=pgCached?0:824000000,probe=pgResident+SYNTHETIC_PG_CAP;
 const candidateCap=B+delta,archiveCap=Math.ceil(candidateCap*1.1);
 const stages={import:{host:importGuest+(localBase?0:A)+bundle.bytes+metadata,guest:importGuest},build:{host:retained+delta+bundle.bytes+metadata,guest:retained+delta+metadata},synthetic:{host:retained+delta+probe+bundle.bytes+metadata,guest:retained+delta+probe},archive:{host:retained+delta+pgResident+candidateCap+archiveCap+bundle.bytes+metadata,guest:retained+delta+pgResident+candidateCap+metadata}};
 // Overall totals above include cumulative residency from the initial baseline.
 // Fresh per-phase df ALREADY contains prior allocations: reserve only future
 // writes below, never subtract a shared df delta as if it were owned usage.
 const futureStages={import:stages.import,build:{host:delta+bundle.bytes+metadata,guest:delta+metadata},synthetic:{host:probe+bundle.bytes+metadata,guest:probe+metadata},archive:{host:candidateCap+archiveCap+bundle.bytes+metadata,guest:candidateCap+metadata}};
 const hostPeak=Math.max(...Object.values(stages).map(s=>s.host)),guestPeak=Math.max(...Object.values(stages).map(s=>s.guest));
 // Keep the former guard as provenance only. Optional daemon policy metadata
 // is not a task allocation, unknown free space, or a second operating reserve.
 const gcAdvisory=Number.isFinite(nativeGcReserve)&&nativeGcReserve>=0?nativeGcReserve:null;
 return {kind:'estimate-from-verified-baseline-and-caps-not-measured-peak',profile:'verified-runtime-overlay',stages,futureStages,hostPeak,guestPeak,hostRequired:RESERVES.physicalFloor+RESERVES.physicalRecovery+Math.ceil(hostPeak*1.2),guestRequired:RESERVES.guestOperational+Math.ceil(guestPeak*1.2),runtimeCap:candidateCap,archiveCap,deltaCap:delta,syntheticPgCap:SYNTHETIC_PG_CAP,baseResident:retained,localBase,pgCached,nativeGcReserve:gcAdvisory,nativeGcRole:'advisory-only-not-admission-or-abort',assumptions:['No pnpm install/full Linux builder or new VM','Cold import includes compressed content + resident image + extraction scratch; local archive deleted after verified load','Archive conservatively includes daemon export scratch as well as one host gzip file','Fresh phase df includes all persisted earlier allocations; sampled deltas include other clients','Generated-client cap twice fresh baseline measured bytes, input capped and verified; native generation/smoke still required','Existing engine automatic GC may free shared unreferenced build cache during work; no manual prune or new deleter is invoked','Shared free-space deltas can include automatic maintenance and other actors, and are not an isolated task peak or upper bound']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try{if(process.argv[2]==='bundle')console.log(JSON.stringify(bundle(process.cwd(),process.argv[3])));else throw Error('overlay-operation');}catch{console.error('runtime-overlay: gate-failed');process.exitCode=1;}
