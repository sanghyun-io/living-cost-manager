// Existing shared engine only. This file contains NO VM lifecycle or prune path.
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,lstatSync,realpathSync,readFileSync,writeFileSync,rmSync,readdirSync,openSync,closeSync,copyFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {REPO,WORKFLOW_PATH,MIGRATION} from './constants.mjs';
import {validateMetadata} from './metadata.mjs';
import {GiB,RESERVES,PUBLIC_BASES,sourceInventory,estimate,admit,warmProofValid} from './resource-budget.mjs';
export {RESERVES};
const hash=b=>createHash('sha256').update(b).digest('hex');
export function identity(env=process.env) {
 const {GITHUB_RUN_ID:run,GITHUB_RUN_ATTEMPT:attempt,GITHUB_SHA:sha}=env;
 if(!/^[1-9][0-9]{0,14}$/.test(run??'')||!/^[1-9][0-9]{0,3}$/.test(attempt??'')||!/^[a-f0-9]{40}$/.test(sha??'')||env.GITHUB_REPOSITORY!==REPO||env.GITHUB_WORKFLOW_REF!==`${REPO}/${WORKFLOW_PATH}@refs/heads/main`||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_ACTOR!=='sanghyun-io')throw Error('build-identity');
 return {run,attempt,sha,context:'colima',key:`${run}-${attempt}-${sha}`};
}
export function parseFree(text,target,guest=true) {
 const lines=text.trim().split('\n'),f=lines[1]?.trim().split(/\s+/),k=Number(f?.[3]);
 if(lines.length!==2||!f?.[0]?.startsWith('/dev/')||!Number.isSafeInteger(k)||k<=0||!f[5]?.startsWith('/')||(guest&&(f[5]==='/'||!(target===f[5]||target.startsWith(f[5]+'/')))))throw Error('capacity-unknown');
 return k*1024;
}
export function humanUpper(s) {
 const m=/^([0-9]+(?:\.[0-9]+)?)(B|kB|MB|GB|TB)$/.exec(s.trim());if(!m)throw Error('image-size-unknown');
 return Math.ceil((+m[1]+1)*({B:1,kB:1e3,MB:1e6,GB:1e9,TB:1e12}[m[2]]));
}
export function command(bin,args,opts={}) {
 const r=spawnSync(bin,args,{encoding:'utf8',timeout:5000,...opts});if(r.status!==0)throw Error('command-failed');return r.stdout.trim();
}
export function readFree(home,run=command) {
 const d=['--context','colima'];
 if(run('docker',[...d,'context','inspect','colima','--format','{{.Endpoints.docker.Host}}'])!==`unix://${home}/.colima/default/docker.sock`||run('docker',[...d,'version','--format','{{.Server.Os}}/{{.Server.Arch}}'])!=='linux/arm64')throw Error('engine-endpoint-or-platform');
 const target=run('docker',[...d,'info','--format','{{.DockerRootDir}}']);if(target!=='/var/lib/docker')throw Error('docker-root');
 return {host:parseFree(run('df',['-Pk',home]),home,false),guest:parseFree(run('colima',['--profile','default','ssh','--','df','-Pk',target]),target)};
}
export function inspectEvidence(workspace,run=command) {
 const inventory=sourceInventory(workspace,run('git',['-C',workspace,'ls-files','-z']).split('\0').filter(Boolean));
 const recipeKey=hash(['scripts/ci/api/image.mjs','scripts/ci/api/build-profile.mjs','scripts/ci/api/resource-budget.mjs'].map(p=>p+'\0'+hash(readFileSync(join(workspace,p)))).join('\n'));
 const base='node:24-alpine',d=['--context','colima'];
 // Official public base only: never read application env/credentials.
 const listed=run('docker',[...d,'image','ls','--filter',`reference=${base}`,'--format','{{.Size}}']);
 let b={},digest=PUBLIC_BASES.nodeDigest,nodeVersion=PUBLIC_BASES.nodeVersion,listing=PUBLIC_BASES.nodeAccountingBytes;
 if(listed) {
  const meta=JSON.parse(run('docker',[...d,'image','inspect',base,'--format','{"Id":{{json .Id}},"Size":{{.Size}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RepoDigests":{{json .RepoDigests}}}']));b=Array.isArray(meta)?meta[0]:meta;digest=b.RepoDigests?.find(x=>x===PUBLIC_BASES.nodeDigest);listing=humanUpper(listed);
  if(!digest)throw Error('base-identity'); // bind the public immutable image BEFORE inspecting its public Node version
  nodeVersion=JSON.parse(run('docker',[...d,'image','inspect',PUBLIC_BASES.nodeDigest,'--format','{{json .Config.Env}}'])).find(x=>x.startsWith('NODE_VERSION='))?.slice(13);
  if(!digest||!/^sha256:[a-f0-9]{64}$/.test(b.Id??'')||!Number.isSafeInteger(b.Size)||b.Size<=0||b.Os!=='linux'||b.Architecture!=='arm64'||nodeVersion!==PUBLIC_BASES.nodeVersion)throw Error('base-identity');
 }
 const pgListed=run('docker',[...d,'image','ls','--filter','reference=postgres:16-alpine','--format','{{.Size}}']);
 let pg=null;if(pgListed){const p=JSON.parse(run('docker',[...d,'image','inspect','postgres:16-alpine','--format','{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},"Os":{{json .Os}},"Architecture":{{json .Architecture}}}']));pg=p.Id;if(!/^sha256:[a-f0-9]{64}$/.test(pg??'')||!p.RepoDigests?.includes(PUBLIC_BASES.pgDigest)||p.Os!=='linux'||p.Architecture!=='arm64')throw Error('synthetic-base-identity');}
 let backend;try{backend=run('docker',[...d,'buildx','version']);}catch{backend=null;}
 const sqlSha256=hash(readFileSync(join(workspace,MIGRATION.dir,'migration.sql')));if(sqlSha256!==MIGRATION.sqlSha256)throw Error('sql-pin');
 return {kind:'read-only-input-evidence',inventory,recipeKey,baseDigest:digest,baseId:b.Id??null,baseCached:!!listed,baseAccountingBytes:Math.max(b.Size??0,listing),baseInspectBytes:b.Size??null,baseListingUpperBytes:listing,nodeVersion,pgCached:!!pgListed,pgId:pg,pgRef:pg??PUBLIC_BASES.pgDigest,backend,sqlSha256};
}
// Cancellation goes to this detached child's group only. For image workers this
// includes the native BuildKit CLI, whose SIGINT cancels its solve context. A
// missing BuildKit plugin blocks admission; legacy disconnect behavior is NOT assumed.
export async function watchChild(bin,args,{env=process.env,cwd,check,interval=5000,timeout=2400000,log,onSpawn=()=>{}}) {
 check();const fd=openSync(log,'a',0o600);let child,active=false,timer,deadline,killTimer,halted=false;
 const terminate=()=>{if(halted)return;halted=true;if(active&&child?.pid){try{process.kill(-child.pid,'SIGINT');}catch{}killTimer=setTimeout(()=>{if(active)try{process.kill(-child.pid,'SIGKILL');}catch{}},10000);}};
 try {
  child=spawn(bin,args,{env,cwd,detached:true,stdio:['ignore',fd,fd]});active=true;onSpawn(child);
  process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
  timer=setInterval(()=>{try{check();}catch{terminate();}},interval);deadline=setTimeout(terminate,timeout);
  const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',c=>{active=false;res(c);});});
  if(halted||code!==0)throw Error('owned-child-halted');check();
 }finally{active=false;clearInterval(timer);clearTimeout(deadline);clearTimeout(killTimer);process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',terminate);closeSync(fd);}
}
const imageFormat='{"Id":{{json .Id}},"Size":{{.Size}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Config":{"Labels":{{json .Config.Labels}}}}';
export function lifecycle({env=process.env,home=homedir(),run=command,evidence:givenEvidence,watch=watchChild,interval=5000,report=r=>console.log(JSON.stringify(r))}={}) {
 const id=identity(env),root=join(home,'.local/state/lcm-api-shared-build'),job=join(root,id.key),leaseFile=join(job,'lease.json'),log=join(job,'private.log'),metricsFile=join(job,'measurement.json');
 const tags={build:`lcm-ci-build-${id.key}:cache`,runtime:`lcm-ci-api-${id.key}:candidate`};
 const resourceKey=`${id.run}-${id.attempt}-${id.sha.slice(0,12)}`; // DNS-safe; labels always bind FULL source SHA
 const names={net:`lcm-ci-net-${resourceKey}`,pg:`lcm-ci-pg-${resourceKey}`,api:`lcm-ci-api-${resourceKey}`,probe:`lcm-ci-probe-${resourceKey}`};
 const labels={'lcm-ci-owner':id.sha,'lcm-ci-run':id.run,'lcm-ci-attempt':id.attempt};
 for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','COLIMA_HOME','COLIMA_PROFILE','LIMA_HOME','LCM_BUILDER_PROFILE'])if(env[k])throw Error('routing-env');
 if(env.LCM_BUILDER_CONTEXT!==undefined&&env.LCM_BUILDER_CONTEXT!=='colima')throw Error('context-binding');
 function safe(p) {const s=lstatSync(p);if(s.isSymbolicLink()||realpathSync(p)!==resolve(p)||s.uid!==process.getuid()||!s.isDirectory()||(s.mode&0o022))throw Error('state-owner');}
 function ensure(p) {let at=home;safe(at);for(const n of p.slice(home.length+1).split('/')){at=join(at,n);if(!existsSync(at))mkdirSync(at,{mode:0o700});safe(at);}}
 function json(p) {const s=lstatSync(p);if(s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw Error('proof-owner');return JSON.parse(readFileSync(p,'utf8'));}
 function owned() {safe(job);const j=json(leaseFile);for(const [k,v]of Object.entries({...id,version:2}))if(j[k]!==v)throw Error('lease-identity');if(!['ready','cleaned'].includes(j.stage)||!j.evidence.backend||!/^[a-f0-9]{64}$/.test(j.evidence.recipeKey??'')||j.evidence.nodeVersion!==PUBLIC_BASES.nodeVersion||j.evidence.sqlSha256!==MIGRATION.sqlSha256||JSON.stringify(j.plan)!==JSON.stringify(estimate(j.evidence,j.plan.profile==='verified-identical-input-cache')))throw Error('lease-budget-shape');return j;}
 const save=j=>writeFileSync(leaseFile,JSON.stringify(j)+'\n',{mode:0o600});
 const docker=(a)=>run('docker',['--context','colima',...a]);
 function engine() {if(docker(['context','inspect','colima','--format','{{.Endpoints.docker.Host}}'])!==`unix://${home}/.colima/default/docker.sock`||docker(['version','--format','{{.Server.Os}}/{{.Server.Arch}}'])!=='linux/arm64')throw Error('engine-endpoint-or-platform');}
 function free() {return readFree(home,run);}
 function remaining(j) {
  const p={...j.plan.parts};if(j.completed.includes('linux-build'))for(const k of ['linuxInstall','packageStore','compile','productionDeploy','basePull','context'])p[k]=0;
  if(j.completed.includes('runtime'))p.runtimeExport=0;if(j.completed.includes('synthetic')){p.syntheticPG=0;p.pgBasePull=0;}if(j.completed.includes('archive'))p.streamedArchive=0;
  const hostPeak=Object.values(p).reduce((a,b)=>a+b,0),guestPeak=hostPeak-p.context-p.streamedArchive;
  return {hostRequired:RESERVES.physicalFloor+RESERVES.physicalRecovery+Math.ceil(hostPeak*1.2),guestRequired:RESERVES.guestOperational+Math.ceil(guestPeak*1.2)};
 }
 function capacity() {let j=owned();if(j.plan.profile==='verified-identical-input-cache'&&!j.completed.includes('linux-build')&&!warmProofValid(j.cacheProof,j.evidence,inspect('image',j.cacheFrom))){j={...j,plan:estimate(j.evidence,false),cacheFrom:null,cacheProof:null};save(j);}const f=free(),r=remaining(j);if(f.host<r.hostRequired||f.guest<r.guestRequired)throw Error('capacity-budget');return {...f,...r};}
 function sample(stage) {
  const f=free();let m=existsSync(metricsFile)?json(metricsFile):{kind:'sampled-actual-not-atomic',sourceSha:id.sha,run:id.run,attempt:id.attempt,status:'in-progress',baseline:owned().admissionFree,min:owned().admissionFree,samples:[],stages:[]};
  m.min={host:Math.min(m.min.host,f.host),guest:Math.min(m.min.guest,f.guest)};m.samples.push({at:new Date().toISOString(),stage,...f});m.samples=m.samples.slice(-1024);
  m.sharedObservedDelta={host:Math.max(0,m.baseline.host-m.min.host),guest:Math.max(0,m.baseline.guest-m.min.guest)};
  writeFileSync(metricsFile,JSON.stringify(m)+'\n',{mode:0o600});
  if(f.host<RESERVES.physicalFloor+RESERVES.physicalRecovery+RESERVES.margin||f.guest<RESERVES.guestOperational+RESERVES.margin)throw Error('capacity-abort');return f;
 }
 function inspect(kind,name) {
  const list=kind==='container'?docker(['container','ls','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}']):kind==='network'?docker(['network','ls','--filter',`name=^${name}$`,'--format','{{.Name}}']):docker(['image','ls','--filter',`reference=${name}`,'--format','{{.Repository}}:{{.Tag}}']);
  if(!list.split('\n').includes(name))return null;
  const fmt=kind==='image'?imageFormat:kind==='container'?'{"Id":{{json .Id}},"Labels":{{json .Config.Labels}}}':'{"Id":{{json .Id}},"Labels":{{json .Labels}}}';
  return JSON.parse(docker([kind,'inspect',name,'--format',fmt]));
 }
 function intent(kind,name) {if(!Object.values(names).includes(name)&&!Object.values(tags).includes(name)&&!(kind==='container'&&name.startsWith(names.probe+'-')&&/^[1-9][0-9]*$/.test(name.slice(names.probe.length+1))))throw Error('resource-name');if(inspect(kind,name))throw Error('foreign-preexisting-resource');const j=owned();if(j.resources.some(r=>r.name===name))throw Error('resource-reuse');j.resources.push({kind,name,baselineAbsent:true});save(j);}
 function verifyResource(r) {
  if(r.baselineAbsent!==true||!['image','container','network'].includes(r.kind)||(!Object.values(names).includes(r.name)&&!Object.values(tags).includes(r.name)&&!(r.kind==='container'&&r.name.startsWith(names.probe+'-')&&/^[1-9][0-9]*$/.test(r.name.slice(names.probe.length+1)))))throw Error('unclaimed-resource');
  const x=inspect(r.kind,r.name);if(!x)return null;const l=x.Config?.Labels??x.Labels;for(const [k,v]of Object.entries(labels))if(l?.[k]!==v)throw Error('foreign-resource-preserved');if(r.createdId&&r.createdId!==x.Id)throw Error('resource-id-drift');if(r.kind==='image'&&owned().preexistingImages.includes(x.Id))throw Error('preexisting-image-id-preserved');
  if(!r.createdId){const j=owned();j.resources=j.resources.map(a=>a.name===r.name?{...a,createdId:x.Id}:a);save(j);}return x;
 }
 function image(which) {const r=owned().resources.find(r=>r.kind==='image'&&r.name===tags[which]);if(!r)throw Error('image-not-registered');const x=verifyResource(r);if(!x||x.Os!=='linux'||x.Architecture!=='arm64'||x.Config?.Labels?.['org.opencontainers.image.revision']!==id.sha)throw Error('candidate-identity');return x;}
 function accounting(which) {const x=image(which);if(!Number.isSafeInteger(x.Size)||x.Size<=0)throw Error('image-accounting-unknown');return Math.max(x.Size,humanUpper(docker(['image','ls','--filter',`reference=${tags[which]}`,'--format','{{.Size}}'])));}
 function check(kind,name) {const r=owned().resources.find(r=>r.kind===kind&&r.name===name);if(!r)throw Error('resource-not-registered');const x=verifyResource(r);if(!x)throw Error('resource-disappeared');return x.Id;}
 function recordOutput(which) {const bytes=accounting(which),j=owned(),cap=which==='build'?j.plan.buildImageCap:j.plan.runtimeCap;if(bytes>cap)throw Error('image-footprint-cap');j.outputs={...j.outputs,[which]:{kind:'image-accounting-upper-not-physical-peak',bytes}};save(j);return bytes;}
 function done(stage) {const j=owned();if(!j.completed.includes(stage))j.completed.push(stage);save(j);}
 function cleanupSynthetic() {
  let failed=false;for(const r of [...owned().resources].reverse().filter(r=>r.kind!=='image'))try{const x=verifyResource(r);if(!x)continue;if(r.kind==='container')docker(['rm','-f','-v',x.Id]);else docker(['network','rm',x.Id]);}catch{failed=true;}if(failed)throw Error('synthetic-cleanup-incomplete');
 }
 function teardown() {
  if(!existsSync(leaseFile))return;let j=owned();if(j.stage==='cleaned')return;let failed=false;
  for(const r of [...j.resources].reverse())try {
   if(r.kind==='image'&&r.name===tags.build&&j.keepBuildCache)continue;
   const x=verifyResource(r);if(!x)continue;
   if(r.kind==='container')docker(['rm','-f','-v',x.Id]);else if(r.kind==='network')docker(['network','rm',x.Id]);else docker(['image','rm',r.name]);
  }catch{failed=true;}
  if(failed)throw Error('resource-cleanup-incomplete');
  for(const p of [join(job,'context'),join(job,'scratch')])if(existsSync(p)){safe(p);rmSync(p,{recursive:true});}
  j={...owned(),stage:'cleaned',controllerPid:null,nonce:null};save(j);
  const lock=join(root,'active');if(existsSync(lock)){if(readFileSync(join(lock,'owner'),'utf8')!==id.key)throw Error('lease-lock-owner');rmSync(join(lock,'owner'));rmSync(lock,{recursive:true});}
 }
 async function prepare() {
  const workspace=realpathSync(env.GITHUB_WORKSPACE??'');if(run('git',['-C',workspace,'rev-parse','HEAD'])!==id.sha||run('git',['-C',workspace,'status','--porcelain','--untracked-files=normal'])!=='')throw Error('source-identity');
  engine();const e=givenEvidence??inspectEvidence(workspace,run);let warm=false,cacheFrom=null,cacheProof=null;
  const warmFile=join(root,`warm-${e.inventory.inputKey}.json`);
  if(existsSync(warmFile))try{const proof=json(warmFile),live=inspect('image',proof.buildImageTag);warm=warmProofValid(proof,e,live);if(warm){cacheFrom=proof.buildImageTag;cacheProof=proof;}}catch{}
  const plan=estimate(e,warm),f=free(),gate=admit(plan,f);
  report({kind:'preflight-estimate-and-free-snapshot-not-build-peak',sourceSha:id.sha,run:id.run,attempt:id.attempt,profile:plan.profile,forecastKind:plan.kind,free:f,required:{host:plan.hostRequired,guest:plan.guestRequired},backendAvailable:!!e.backend,admitted:gate.fits&&!!e.backend,sampledBuildPeak:null});
  // Report evidence without acquiring a build lease or mutating Docker when blocked.
  if(!gate.fits||!e.backend)throw Error(!e.backend?'native-buildkit-unavailable':'capacity-budget');
  const preexistingImages=docker(['image','ls','--no-trunc','--quiet']).split('\n').filter(Boolean);
  if(preexistingImages.some(x=>!/^sha256:[a-f0-9]{64}$/.test(x))||(e.baseId&&!preexistingImages.includes(e.baseId))||(e.pgId&&!preexistingImages.includes(e.pgId)))throw Error('image-inventory-unknown');
  ensure(root);if(existsSync(job))throw Error('job-lease-preexisting');mkdirSync(join(root,'active'),{mode:0o700});writeFileSync(join(root,'active/owner'),id.key,{mode:0o600,flag:'wx'});mkdirSync(job,{mode:0o700});
  save({...id,version:2,stage:'ready',workspace,evidence:e,plan,cacheFrom,cacheProof,completed:[],resources:[],preexistingImages,admissionFree:f,retainedSharedCache:'BuildKit can retain completed layers on success/cancellation; no shared prune. Review sampled growth before another attempt.',execution:env.GITHUB_ACTIONS==='true'?'github-actions':'local-controlled-measurement'});
  try {
   const context=join(job,'context');mkdirSync(context,{mode:0o700});mkdirSync(join(job,'scratch'),{mode:0o700});
   for(const f of e.inventory.files){const from=join(workspace,f.path),to=join(context,f.path);if(hash(readFileSync(from))!==f.sha256)throw Error('source-toctou');mkdirSync(dirname(to),{recursive:true,mode:0o700});copyFileSync(from,to);}
   const dockerfile=join(context,'apps/api/Dockerfile'),text=readFileSync(dockerfile,'utf8');if((text.match(/^FROM node:24-alpine AS /gm)??[]).length!==2)throw Error('dockerfile-contract');writeFileSync(dockerfile,text.replaceAll('FROM node:24-alpine AS ',`FROM ${e.baseDigest} AS `));
   save({...owned(),stagedDockerfileSha256:hash(readFileSync(dockerfile))});
   sample('prepared');if(!env.GITHUB_ENV)throw Error('github-env-required');writeFileSync(env.GITHUB_ENV,`LCM_BUILDER_CONTEXT=colima\nLCM_CI_API_STATE_DIR=${join(job,'scratch')}\n`,{flag:'a',mode:0o600});
  }catch{teardown();throw Error('prepare-failed');}
 }
 async function runImage(args) {
  const j=owned();if(j.controllerPid||args.includes('--profile-worker')||!['build','synthetic','archive'].includes(args[0])||args[args.indexOf('--sha')+1]!==id.sha)throw Error('image-operation');
  const nonce=randomBytes(24).toString('hex');
  try{capacity();save({...owned(),controllerPid:process.pid,nonce});await watch(process.execPath,[fileURLToPath(new URL('./image.mjs',import.meta.url)),...args,'--profile-worker'],{env:{...env,DOCKER_BUILDKIT:'1',LCM_PROFILE_CONTROLLER_NONCE:nonce},cwd:j.workspace,log,interval,check:()=>sample(args[0])});if(args[0]==='archive')completeProof();}
  catch{if(existsSync(metricsFile)){const m=json(metricsFile);m.status='failed-or-cancelled';writeFileSync(metricsFile,JSON.stringify(m),{mode:0o600});}teardown();throw Error('image-halted');}
  finally{save({...owned(),controllerPid:null,nonce:null});}
 }
 function worker() {const j=owned();if(j.controllerPid!==process.ppid||!j.nonce||j.nonce!==env.LCM_PROFILE_CONTROLLER_NONCE)throw Error('unmonitored-worker');}
 function completeProof() {
  const j=owned(),m=json(metricsFile);if(!['linux-build','runtime','synthetic','archive'].every(s=>j.completed.includes(s))||m.kind!=='sampled-actual-not-atomic'||m.samples.length<2||!Number.isFinite(j.outputs?.build?.bytes)||j.outputs.build.bytes<=0||j.outputs.build.bytes>j.plan.buildImageCap||!Number.isFinite(j.outputs?.runtime?.bytes)||j.outputs.runtime.bytes<=0||j.outputs.runtime.bytes>j.plan.runtimeCap)throw Error('measurement-incomplete');
  const build=image('build');if(!build.Config.Labels?.['moby.buildkit.cache.v0'])throw Error('inline-cache-missing');
  const archive=json(join(job,'archive-metadata.json'));validateMetadata(archive,id.sha,env);if(archive.imageId!==image('runtime').Id||archive.archiveBytes>j.plan.archiveCap)throw Error('measurement-archive-binding');
  const proof={...m,status:'passed',repo:REPO,inputKey:j.evidence.inventory.inputKey,recipeKey:j.evidence.recipeKey,baseDigest:j.evidence.baseDigest,backend:j.evidence.backend,nodeVersion:j.evidence.nodeVersion,stagedDockerfileSha256:j.stagedDockerfileSha256,sqlSha256:MIGRATION.sqlSha256,syntheticHealth:true,buildImageId:build.Id,buildImageTag:tags.build,outputs:j.outputs,archiveSha256:archive.archiveSha256,archiveBytes:archive.archiveBytes,execution:j.execution};
  const ref=join(root,`warm-${proof.inputKey}.json`);if(existsSync(ref)){const previous=json(ref);if(previous.kind!=='sampled-actual-not-atomic'||previous.inputKey!==proof.inputKey)throw Error('unknown-cache-proof-preserved');}
  writeFileSync(metricsFile,JSON.stringify(proof),{mode:0o600});writeFileSync(ref,JSON.stringify(proof),{mode:0o600});save({...j,keepBuildCache:true});
 }
 return {id,job,root,leaseFile,tags,names,labels,owned,engine,free,capacity,prepare,teardown,cleanupSynthetic,runImage,worker,intent,inspect,image,accounting,check,recordOutput,done,completeProof,sample};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  if(process.argv[2]==='plan') {
   const workspace=process.cwd(),e=inspectEvidence(workspace),plan=estimate(e,false),home=homedir();
   const free=readFree(home);
   console.log(JSON.stringify({evidence:e,forecast:plan,free,gate:admit(plan,free),backendAvailable:!!e.backend},null,2));
  }else if(process.argv[2]==='native-capacity') {if(parseFree(command('df',['-Pk',homedir()]),homedir(),false)<RESERVES.physicalFloor+RESERVES.physicalRecovery+0.2*GiB*1.2)throw Error('native-capacity');}
  else {const l=lifecycle();if(process.argv[2]==='prepare')await l.prepare();else if(process.argv[2]==='teardown')l.teardown();else throw Error('operation');}
 }catch{console.error('shared-build: gate-failed; inspect exact run/attempt/source private lease or read-only plan; no VM lifecycle fallback');process.exitCode=1;}
}
