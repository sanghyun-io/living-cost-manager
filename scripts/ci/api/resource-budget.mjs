// Project-specific forecasts, NOT measurements or a second physical floor in a VM.
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {BUDGET} from './constants.mjs';
export const GiB=1024**3,MiB=1024**2;
export const REFERENCE=Object.freeze({kind:'measured-darwin-reference-not-linux',at:'2026-10-19',dependencyBytes:914145280,packageKey:'a09911e4e514d640bd1f238427a583aabf5f503671121ad3f1937a4712f39c2c',historicalRuntimeBytes:660000000,historicalArchiveBytes:153910829,sourceBytes:600480,sourceFiles:96});
export const RESERVES=Object.freeze({physicalFloor:BUDGET.mac.floorGib*GiB,physicalRecovery:BUDGET.mac.reserveGib*GiB,guestOperational:2*GiB,margin:GiB/2});
export const PUBLIC_BASES=Object.freeze({nodeDigest:'node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1',nodeVersion:'24.21.0',nodeAccountingBytes:239000000,pgDigest:'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',pgAccountingBytes:412000000});
const packages=['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','apps/api/package.json','apps/web/package.json','packages/shared/package.json'].sort();
const hash=b=>createHash('sha256').update(b).digest('hex');
export function sourceInventory(root,tracked) {
 const files=tracked.filter(p=>packages.includes(p)||p==='.dockerignore'||p==='apps/api/Dockerfile'||p.startsWith('prisma/')||/^packages\/shared\/(src\/|tsconfig.json$)/.test(p)||/^apps\/api\/(src\/|tsconfig.json$)/.test(p)).sort();
 if(!files.includes('apps/api/Dockerfile')||packages.some(p=>!files.includes(p)))throw Error('build-inputs-missing');
 const h=createHash('sha256'),ph=createHash('sha256');let bytes=0;
 const entries=files.map(p=>{
  if(p.startsWith('/')||p.split('/').some(x=>!x||x==='..')||/[\r\n\0\\]/.test(p))throw Error('build-input-path');
  const s=lstatSync(join(root,p));if(!s.isFile()||s.isSymbolicLink())throw Error('build-input-type');
  const data=readFileSync(join(root,p));bytes+=data.length;h.update(p+'\0').update(data).update('\0');
  if(packages.includes(p))ph.update(p+'\0').update(data).update('\0');
  return {path:p,bytes:data.length,sha256:hash(data)};
 });
 // Input cap derived from observed public source, not chosen to fit today's df.
 if(bytes>Math.ceil(REFERENCE.sourceBytes*4/MiB)*MiB)throw Error('build-context-cap');
 return {kind:'actual-source-inventory',bytes,files:entries,inputKey:h.digest('hex'),packageKey:ph.digest('hex')};
}
export function estimate(e,warm=false) {
 if(e.inventory.packageKey!==REFERENCE.packageKey)throw Error('dependency-reference-stale');
 const runtimeCap=Math.ceil(REFERENCE.historicalRuntimeBytes*1.5/MiB)*MiB;
 const dependencyCap=REFERENCE.dependencyBytes*2; // unmeasured Linux allowance; no Darwin binaries shipped
 const compileCap=128*MiB+e.inventory.bytes*8;
 const parts={context:e.inventory.bytes+e.inventory.files.length*4096,
  basePull:e.baseCached?0:e.baseAccountingBytes*2,pgBasePull:e.pgCached?0:PUBLIC_BASES.pgAccountingBytes*2,
  linuxInstall:warm?0:dependencyCap,packageStore:warm?0:dependencyCap,
  compile:warm?0:compileCap,productionDeploy:warm?0:runtimeCap,
  runtimeExport:runtimeCap,streamedArchive:Math.ceil(runtimeCap*1.1),syntheticPG:256*MiB,buildMetadata:256*MiB};
 // Persisted intermediate outputs remain in this total across ALL stages.
 const hostPeak=Object.values(parts).reduce((a,b)=>a+b,0);
 const guestPeak=hostPeak-parts.context-parts.streamedArchive;
 return {kind:'estimate-from-caps-not-measurement',profile:warm?'verified-identical-input-cache':'cold-unverified-cache',parts,hostPeak,guestPeak,
  hostRequired:RESERVES.physicalFloor+RESERVES.physicalRecovery+Math.ceil(hostPeak*1.2),
  guestRequired:RESERVES.guestOperational+Math.ceil(guestPeak*1.2),
  runtimeCap,buildImageCap:dependencyCap*2+runtimeCap+compileCap,archiveCap:parts.streamedArchive,
  assumptions:['Linux install allowance = twice measured Darwin dependency reference; NOT measured Linux usage','No credit for anonymous/shared build-cache du','Warm credit requires a live retained inline-cache image AND successful same-input sampled proof','Streaming avoids a plain tar and duplicate archive','Guest reserve 2GiB is LCM operational headroom, not the host physical policy floor','Caps and sampled minima are not atomic guarantees; shared activity is included']};
}
export function admit(plan,free) {
 if(!Number.isFinite(free.host)||!Number.isFinite(free.guest)||free.host<=0||free.guest<=0)throw Error('capacity-unknown');
 return {fits:free.host>=plan.hostRequired&&free.guest>=plan.guestRequired,hostRequired:plan.hostRequired,guestRequired:plan.guestRequired};
}
export function warmProofValid(proof,e,live) {
 const cap=estimate(e,false);
 return !!(proof&&proof.kind==='sampled-actual-not-atomic'&&proof.status==='passed'&&proof.syntheticHealth===true&&proof.inputKey===e.inventory.inputKey&&/^[a-f0-9]{64}$/.test(e.recipeKey??'')&&proof.recipeKey===e.recipeKey&&proof.baseDigest===e.baseDigest&&proof.backend===e.backend&&proof.nodeVersion===e.nodeVersion&&
  proof.repo==='sanghyun-io/living-cost-manager'&&/^[a-f0-9]{40}$/.test(proof.sourceSha??'')&&/^[1-9][0-9]*$/.test(proof.run??'')&&/^[1-9][0-9]*$/.test(proof.attempt??'')&&proof.buildImageTag===`lcm-ci-build-${proof.run}-${proof.attempt}-${proof.sourceSha}:cache`&&
  proof.sqlSha256===e.sqlSha256&&proof.buildImageId===live?.Id&&live?.Config?.Labels?.['lcm-ci-input']===e.inventory.inputKey&&live?.Config?.Labels?.['org.opencontainers.image.revision']===proof.sourceSha&&live?.Config?.Labels?.['lcm-ci-run']===proof.run&&live?.Config?.Labels?.['lcm-ci-attempt']===proof.attempt&&live?.Config?.Labels?.['moby.buildkit.cache.v0']&&
  Number.isFinite(proof.outputs?.build?.bytes)&&proof.outputs.build.bytes>0&&proof.outputs.build.bytes<=cap.buildImageCap&&Number.isFinite(proof.outputs?.runtime?.bytes)&&proof.outputs.runtime.bytes>0&&proof.outputs.runtime.bytes<=cap.runtimeCap&&/^[a-f0-9]{64}$/.test(proof.archiveSha256??'')&&Number.isSafeInteger(proof.archiveBytes)&&proof.archiveBytes>0&&proof.archiveBytes<=cap.archiveCap&&
  Array.isArray(proof.samples)&&proof.samples.length>=2&&proof.samples.every(s=>Number.isFinite(s.host)&&s.host>=RESERVES.physicalFloor+RESERVES.physicalRecovery+RESERVES.margin&&Number.isFinite(s.guest)&&s.guest>=RESERVES.guestOperational+RESERVES.margin));
}
