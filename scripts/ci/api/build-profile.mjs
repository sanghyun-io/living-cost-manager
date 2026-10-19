// Owned, fresh-only Colima builder. No shared-engine mutation or context switch.
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,lstatSync,realpathSync,readFileSync,writeFileSync,rmSync,readdirSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,totalmem} from 'node:os';
import {fileURLToPath} from 'node:url';
import {REPO,WORKFLOW_PATH,BUDGET} from './constants.mjs';
const bootstrapPeak=1.85;
const imageAdmission=BUDGET.mac.floorGib+BUDGET.mac.buildPeakGib*1.2+BUDGET.mac.reserveGib;
export const LIMITS=Object.freeze({startup:Math.ceil((imageAdmission+bootstrapPeak)*10)/10,build:imageAdmission,abort:BUDGET.mac.floorGib+BUDGET.mac.reserveGib+0.5,memory:4});
const GiB=1024**3;
const hash=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function identity(env=process.env) {
  const {GITHUB_RUN_ID:run,GITHUB_RUN_ATTEMPT:attempt,GITHUB_SHA:sha}=env;
  if(!/^[1-9][0-9]{0,14}$/.test(run??'')||!/^[1-9][0-9]{0,3}$/.test(attempt??'')||!/^[a-f0-9]{40}$/.test(sha??'')||
    env.GITHUB_REPOSITORY!==REPO||env.GITHUB_WORKFLOW_REF!==`${REPO}/${WORKFLOW_PATH}@refs/heads/main`||
    env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_ACTOR!=='sanghyun-io')throw Error('builder-identity');
  const profile=`lcm-api-build-${run}-${attempt}`;
  return {run,attempt,sha,profile,context:`colima-${profile}`};
}
export function parseFree(text,target,requireMount=true) {
  const f=text.trim().split('\n');
  if(f.length!==2)throw Error('capacity-output');
  const parts=f[1].trim().split(/\s+/),k=Number(parts[3]);
  if(!parts[0]?.startsWith('/dev/')||!Number.isSafeInteger(k)||k<=0||!parts[5]?.startsWith('/')||
    (requireMount&&(parts[5]==='/'||!(target===parts[5]||target.startsWith(parts[5].replace(/\/$/,'')+'/')))))throw Error('capacity-mount');
  return k/1024**2;
}
export function assertMounts(y,workspace) {
  if(!Array.isArray(y.mounts)||y.mounts.length!==1||y.mounts[0].location!==workspace||y.mounts[0].writable!==false||
    y.ssh?.forwardAgent!==false||y.ssh?.loadDotSSHPubKeys!==false||y.mountType!=='virtiofs')throw Error('builder-mounts');
}
// This monitor owns exactly one detached child process group. It never looks up
// or kills another process by name/PID discovered outside that child handle.
export async function watchChild(bin,args,{env=process.env,cwd,check,interval=5000,timeout=2400000,log,onSpawn=()=>{}}) {
  check();
  const fd=openSync(log,'a',0o600);
  let child,active=false,timer,killTimer,deadline,halted=false;
  const terminate=()=>{
    if(halted)return;
    halted=true;
    if(active && child?.pid) {
      try{process.kill(-child.pid,'SIGTERM');}catch{}
      killTimer=setTimeout(()=>{if(active)try{process.kill(-child.pid,'SIGKILL');}catch{}},10000);
    }
  };
  const signal=()=>terminate();
  try {
    child=spawn(bin,args,{env,cwd,detached:true,stdio:['ignore',fd,fd]});active=true;onSpawn(child);
    process.once('SIGTERM',signal);process.once('SIGINT',signal);
    timer=setInterval(()=>{try{check();}catch{terminate();}},interval);
    deadline=setTimeout(terminate,timeout);
    const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',code=>{active=false;res(code);});});
    if(halted||code!==0)throw Error('owned-child-halted');
    check();
  } finally {
    active=false;clearInterval(timer);clearTimeout(killTimer);clearTimeout(deadline);
    process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);closeSync(fd);
  }
}
export function lifecycle({env=process.env,home=homedir(),run:injectedRun,hostFree:injectedHost,memory:injectedMemory,platform=process.platform,arch=process.arch,interval=5000,watch=watchChild}={}) {
  const id=identity(env),root=join(home,'.local/state/lcm-api-build'),job=join(root,`${id.run}-${id.attempt}`),leaseFile=join(job,'lease.json');
  const profileDir=join(home,'.colima',id.profile),limaDir=join(home,'.colima/_lima',id.context),diskDir=join(home,'.colima/_lima/_disks',id.context);
  const marker=join(profileDir,'.lcm-owned.json'),lock=join(root,'active'),log=join(job,'private.log');
  for(const [k,v]of Object.entries({LCM_BUILDER_PROFILE:id.profile,LCM_BUILDER_CONTEXT:id.context,LCM_CI_API_STATE_DIR:join(job,`lcm-ci-api-${id.sha.slice(0,12)}`)}))if(env[k]!==undefined&&env[k]!==v)throw Error('builder-export-identity');
  for(const k of ['COLIMA_HOME','LIMA_HOME','COLIMA_PROFILE','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG'])if(env[k])throw Error('builder-routing-env');
  const checkDir=p=>{
    const s=lstatSync(p);if(s.isSymbolicLink()||realpathSync(p)!==resolve(p)||!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o022))throw Error('builder-path-owner');
  };
  function safeParents(p) {
    if(realpathSync(home)!==resolve(home))throw Error('builder-home-link');
    let at=home;checkDir(at);
    for(const segment of p.slice(home.length+1).split('/')) {at=join(at,segment);if(!existsSync(at))mkdirSync(at,{mode:0o700});checkDir(at);}
  }
  function run(bin,args,opts={}) {
    if(injectedRun)return injectedRun(bin,args,opts);
    const fd=existsSync(job)?openSync(log,'a',0o600):undefined;
    try {
      const r=spawnSync(bin,args,{encoding:'utf8',env,timeout:120000,stdio:['ignore','pipe',fd??'pipe'],...opts});
      if(r.status!==0)throw Error('builder-command');return r.stdout.trim();
    }finally{if(fd!==undefined)closeSync(fd);}
  }
  const hostFree=()=>injectedHost?injectedHost():parseFree(run('df',['-Pk',home],{timeout:5000}),home,false);
  function hostGate(n) {const free=hostFree();if(!Number.isFinite(free)||free<n)throw Error('host-capacity-budget');return free;}
  const owner=()=>({version:1,...id});
  function readLease() {
    checkDir(job);if((lstatSync(job).mode&0o777)!==0o700)throw Error('builder-job-mode');const s=lstatSync(leaseFile);
    if(s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw Error('builder-lease-owner');
    const j=JSON.parse(readFileSync(leaseFile,'utf8'));
    for(const [k,v]of Object.entries(owner()))if(j[k]!==v)throw Error('builder-lease-identity');
    if(typeof j.claimed!=='boolean'||!['claiming','starting','ready','cleaned'].includes(j.stage)||typeof j.workspace!=='string'||!j.workspace.startsWith('/')||(j.stage==='ready'&&!j.claimed))throw Error('builder-lease-shape');
    return j;
  }
  const save=j=>writeFileSync(leaseFile,JSON.stringify(j)+'\n',{mode:0o600});
  function validateMarker() {
    checkDir(profileDir);const s=lstatSync(marker);
    if(s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||!same(JSON.parse(readFileSync(marker,'utf8')),owner()))throw Error('builder-marker');
  }
  function owned({ready=true,exported=true}={}) {
    const j=readLease();validateMarker();
    if(ready&&j.stage!=='ready')throw Error('builder-not-ready');
    if(exported&&(env.LCM_BUILDER_PROFILE!==id.profile||env.LCM_BUILDER_CONTEXT!==id.context||env.LCM_CI_API_STATE_DIR!==join(job,`lcm-ci-api-${id.sha.slice(0,12)}`)))throw Error('builder-context-binding');
    return j;
  }
  function guestFree() {
    engine();
    const dockerRoot=run('docker',['--context',id.context,'info','--format','{{.DockerRootDir}}'],{timeout:5000});
    if(!/^\/[A-Za-z0-9/_-]+$/.test(dockerRoot))throw Error('builder-docker-root');
    return parseFree(run('colima',['--profile',id.profile,'ssh','--','df','-Pk',dockerRoot],{timeout:5000}),dockerRoot);
  }
  function engine() {
    const endpoint=run('docker',['--context',id.context,'context','inspect',id.context,'--format','{{.Endpoints.docker.Host}}'],{timeout:5000});
    if(endpoint!==`unix://${profileDir}/docker.sock`)throw Error('builder-endpoint-mismatch');
  }
  function capacity(threshold=LIMITS.build) {
    owned();const host=hostGate(threshold),guest=guestFree();
    if(!Number.isFinite(guest)||guest<threshold)throw Error('guest-capacity-budget');
    return {host,guest};
  }
  function snapshot() {
    const current=run('docker',['context','show']); // client metadata ONLY, no engine call
    const contexts=run('docker',['context','ls','--format','{{.Name}}']).split('\n').filter(n=>n&&n!==id.context).sort();
    const containers=run('docker',['--context','colima','ps','-aq']).split('\n').filter(Boolean).sort(); // read-only shared inventory
    const sshFile=join(home,'.colima/ssh_config');
    return {current,contexts,containers,sshConfig:existsSync(sshFile)?hash(readFileSync(sshFile)):null};
  }
  function unlock() {
    if(!existsSync(lock))return;
    checkDir(lock);
    if(!same(JSON.parse(readFileSync(join(lock,'owner.json'),'utf8')),owner()))throw Error('builder-lock-owner');
    if(readdirSync(lock).some(n=>n!=='owner.json'))throw Error('builder-lock-content');
    rmSync(join(lock,'owner.json'));rmSync(lock,{recursive:true});
  }
  function teardown() {
    if(!existsSync(leaseFile)) {
      if(existsSync(profileDir)||existsSync(limaDir)||existsSync(diskDir))throw Error('unknown-builder-preserved');
      return;
    }
    let j=readLease();
    if(j.stage==='cleaned') {
      if(existsSync(profileDir)||existsSync(limaDir)||existsSync(diskDir))throw Error('builder-reappeared');
      return;
    }
    if(j.claimed) {
      if(!existsSync(profileDir))throw Error('builder-marker-missing-preserved');
      validateMarker();
      for(const p of [limaDir,diskDir])if(existsSync(p))checkDir(p);
      if(existsSync(limaDir)||existsSync(diskDir)||existsSync(join(profileDir,'colima.yaml'))) {
        // These are the only destructive machine commands. Identity and marker
        // are revalidated immediately before BOTH; never default, never sweep.
        // A failed/partial boot may already be stopped. Still attempt official
        // force-delete of THIS marked resource; never leave it merely because stop failed.
        try{run('colima',['--profile',id.profile,'stop']);}catch{}
        validateMarker();
        run('colima',['--profile',id.profile,'delete','--force','--data']);
      } else {
        if(readdirSync(profileDir).some(n=>n!=='.lcm-owned.json'))throw Error('partial-builder-unknown-content');
        rmSync(marker);rmSync(profileDir,{recursive:true});
      }
      // Official delete must remove VM + runtime data, not merely root disk.
      if(existsSync(limaDir)||existsSync(diskDir))throw Error('builder-cleanup-incomplete');
      if(existsSync(profileDir)) {
        validateMarker();
        if(readdirSync(profileDir).some(n=>n!=='.lcm-owned.json'))throw Error('builder-cleanup-content');
        rmSync(marker);rmSync(profileDir,{recursive:true});
      }
    }
    const scratch=join(job,`lcm-ci-api-${id.sha.slice(0,12)}`);
    if(existsSync(scratch)){checkDir(scratch);rmSync(scratch,{recursive:true});}
    let after=null,measurementFailed=false;try{after=hostFree();}catch{measurementFailed=true;}
    j={...j,stage:'cleaned',controllerPid:null,nonce:null,cleanedAt:new Date().toISOString(),hostAfter:after};save(j);unlock();
    if(j.before&&!same(snapshot(),j.before))throw Error('shared-state-drift');
    if(measurementFailed)throw Error('cleanup-capacity-unknown');
  }
  async function start() {
    if(platform!=='darwin'||arch!=='arm64')throw Error('builder-platform');
    hostGate(LIMITS.startup);
    const available=injectedMemory?injectedMemory():(()=>{
      const v=run('vm_stat',[]),page=Number(v.match(/page size of (\d+) bytes/)?.[1]);
      const pages=['free','inactive','speculative'].map(k=>Number(v.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1]));
      if(!page||pages.some(p=>!Number.isFinite(p)))throw Error('builder-memory-measure');
      return page*pages.reduce((a,b)=>a+b,0)/GiB;
    })();
    if(!Number.isFinite(available)||available<LIMITS.memory||(!injectedMemory&&totalmem()<8*GiB))throw Error('builder-memory-budget');
    if(!/^colima version 0\.10\.3(?:\n|$)/.test(run('colima',['version'])))throw Error('builder-colima-version');
    const workspace=realpathSync(env.GITHUB_WORKSPACE??'');
    if(workspace===home||workspace==='/'||home.startsWith(workspace+'/')||/[\n\r:,]/.test(workspace)||workspace.startsWith(join(home,'.ssh'))||workspace.startsWith(join(home,'.colima')))throw Error('builder-workspace');
    if(run('git',['-C',workspace,'rev-parse','HEAD'])!==id.sha||run('git',['-C',workspace,'status','--porcelain','--untracked-files=normal'])!=='')throw Error('builder-workspace-source');
    if(existsSync(profileDir)||existsSync(limaDir)||existsSync(diskDir)||existsSync(job))throw Error('preexisting-builder-preserved');
    if(run('docker',['context','ls','--format','{{.Name}}']).split('\n').includes(id.context))throw Error('preexisting-context-preserved');
    for(const p of [join(home,'.colima'),join(home,'.colima/_lima'),join(home,'.colima/_lima/_disks')])if(existsSync(p))checkDir(p);
    const before=snapshot();
    safeParents(root);safeParents(join(home,'.colima'));
    if((lstatSync(root).mode&0o777)!==0o700)throw Error('builder-state-mode');
    mkdirSync(lock,{mode:0o700}); // atomic, one active LCM builder; no lease reuse
    writeFileSync(join(lock,'owner.json'),JSON.stringify(owner()),{mode:0o600,flag:'wx'});
    mkdirSync(job,{mode:0o700});
    let j={...owner(),stage:'claiming',claimed:false,workspace,before,hostBefore:hostFree(),createdAt:new Date().toISOString(),
      budget:{startupGib:LIMITS.startup,bootstrapPeakGib:bootstrapPeak,imagePeakGib:BUDGET.mac.buildPeakGib,buildFreeGib:LIMITS.build,abortFreeGib:LIMITS.abort},
      resources:{profileDir,limaDir,diskDir,disposition:'official owned-profile delete --data after upload; retain small private proof',publicBootCache:'official Colima 0.10.3 checksum-protected reusable blob; never delete shared caches; review after first run'}};
    writeFileSync(leaseFile,JSON.stringify(j),{mode:0o600,flag:'wx'});
    try {
      mkdirSync(profileDir,{mode:0o700}); // exclusive namespace claim BEFORE provisioning
      writeFileSync(marker,JSON.stringify(owner()),{mode:0o600,flag:'wx'});
      j={...j,claimed:true,stage:'starting'};save(j);
      if(existsSync(limaDir)||existsSync(diskDir))throw Error('builder-namespace-race');
      hostGate(LIMITS.startup); // fresh forecast gate immediately before cold allocation
      await watch('colima',['--profile',id.profile,'start','--activate=false','--ssh-config=false','--template=false','--ssh-agent=false','--cpus','2','--memory','3','--disk','40','--root-disk','20','--runtime','docker','--arch','aarch64','--vm-type','vz','--mount-type','virtiofs','--mount',workspace],{env,log,interval,timeout:600000,check:()=>hostGate(LIMITS.abort)});
      validateMarker();checkDir(limaDir);
      const yamlFile=join(limaDir,'lima.yaml'),ys=lstatSync(yamlFile);
      if(ys.isSymbolicLink()||ys.uid!==process.getuid())throw Error('builder-yaml-owner');
      const y=JSON.parse(run('ruby',['-ryaml','-rjson','-e','puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], aliases: false))',yamlFile]));
      assertMounts(y,workspace);
      engine();
      if(run('docker',['--context',id.context,'version','--format','{{.Server.Os}}/{{.Server.Arch}}'])!=='linux/arm64')throw Error('builder-engine-platform');
      if(!same(snapshot(),before))throw Error('shared-state-drift');
      hostGate(LIMITS.build);if(guestFree()<LIMITS.build)throw Error('guest-capacity-budget');
      j={...j,stage:'ready'};save(j);
      const values={LCM_BUILDER_PROFILE:id.profile,LCM_BUILDER_CONTEXT:id.context,LCM_CI_API_STATE_DIR:join(job,`lcm-ci-api-${id.sha.slice(0,12)}`)};
      if(!env.GITHUB_ENV)throw Error('builder-github-env');
      const fd=openSync(env.GITHUB_ENV,'a',0o600);try{for(const [k,v]of Object.entries(values))writeFileSync(fd,`${k}=${v}\n`);}finally{closeSync(fd);}
      return values;
    }catch{
      teardown();throw Error('builder-start-halted');
    }
  }
  async function runImage(args) {
    const j=owned();
    if(j.controllerPid)throw Error('builder-controller-active');
    if(!['build','synthetic','archive'].includes(args[0])||args.includes('--profile-worker')||args.indexOf('--sha')<0||args[args.indexOf('--sha')+1]!==id.sha)throw Error('builder-image-operation');
    try {
      capacity();
      const nonce=randomBytes(24).toString('hex');save({...j,controllerPid:process.pid,nonce});
      await watch(process.execPath,[fileURLToPath(new URL('./image.mjs',import.meta.url)),...args,'--profile-worker'],{env:{...env,LCM_PROFILE_CONTROLLER_NONCE:nonce},cwd:j.workspace,log,interval,check:()=>capacity(LIMITS.abort)});
    }catch{
      teardown();throw Error('builder-image-halted');
    }finally{
      const latest=readLease();save({...latest,controllerPid:null,nonce:null});
    }
  }
  function worker() {
    const j=owned();
    if(j.controllerPid!==process.ppid||!j.nonce||j.nonce!==env.LCM_PROFILE_CONTROLLER_NONCE)throw Error('unmonitored-image-worker');
  }
  return {id,job,profileDir,limaDir,diskDir,leaseFile,marker,root,start,teardown,owned,engine,capacity,guestFree,hostGate,runImage,worker};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv[2]==='native-capacity') {
      const home=homedir(),r=spawnSync('df',['-Pk',home],{encoding:'utf8',timeout:5000});
      if(r.status!==0||parseFree(r.stdout,home,false)<LIMITS.build)throw Error('native-capacity');
    } else {
      const l=lifecycle();
      if(process.argv[2]==='start')await l.start();else if(process.argv[2]==='teardown')l.teardown();else throw Error('builder-operation');
    }
    console.log('build-profile: ok');
  } catch {
    let hint='identity-unverified; no namespace selected';
    try {const i=identity();hint=`profile=${i.profile} context=${i.context} lease=${join(homedir(),'.local/state/lcm-api-build',`${i.run}-${i.attempt}`,'lease.json')}`;}catch{}
    console.error(`build-profile: gate-failed ${hint}; inspect private journal if cleanup incomplete`);process.exitCode=1;
  }
}
