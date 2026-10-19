import {describe,it,expect,afterEach} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,statSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {identity,lifecycle,watchChild,assertMounts,parseFree,LIMITS} from './build-profile.mjs';
const roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(extra={}) {
 const home=realpathSync(mkdtempSync(join(tmpdir(),'lcm-builder-')));roots.push(home);
 const workspace=join(home,'workspace');mkdirSync(workspace,{mode:0o700});
 const env:any={GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'b'.repeat(40),GITHUB_REPOSITORY:'sanghyun-io/living-cost-manager',GITHUB_WORKFLOW_REF:'sanghyun-io/living-cost-manager/.github/workflows/ci.yml@refs/heads/main',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'push',GITHUB_ACTOR:'sanghyun-io',GITHUB_WORKSPACE:workspace,GITHUB_ENV:join(home,'github-env'),...extra};
 const id=identity(env),pd=join(home,'.colima',id.profile),ld=join(home,'.colima/_lima',id.context),dd=join(home,'.colima/_lima/_disks',id.context);
 const state:any={host:23,guest:36,memory:5,version:'colima version 0.10.3\ngit commit: public',current:'colima',ids:Array.from({length:21},(_,i)=>String(i).padStart(12,'0')),mounts:{mounts:[{location:workspace,writable:false}],mountType:'virtiofs',ssh:{forwardAgent:false,loadDotSSHPubKeys:false}}};
 const calls:Array<{bin:string,args:string[]}>=[];
 const run=(bin:string,args:string[])=>{
  calls.push({bin,args});
  if(bin==='docker'&&args.join(' ')==='context show')return state.current;
  if(bin==='docker'&&args.join(' ')==='context ls --format {{.Name}}')return ['default','colima','figuredeal',...(state.foreignContext?[id.context]:[])].join('\n');
  if(bin==='docker'&&args.join(' ')==='--context colima ps -aq')return state.ids.join('\n');
  if(bin==='colima'&&args[0]==='version')return state.version;
  if(bin==='git') {expect(args.slice(0,2)).toEqual(['-C',workspace]);return args[2]==='rev-parse'?(state.wrongHead?'c'.repeat(40):id.sha):(state.dirty?' M tracked-source':'');}
  if(bin==='ruby')return readFileSync(join(ld,'lima.yaml'),'utf8');
  if(bin==='docker') {
   expect(args.slice(0,2)).toEqual(['--context',id.context]);
   if(args[2]==='info')return '/var/lib/docker';
   if(args[2]==='context')return state.badEndpoint?'unix:///foreign/default.sock':`unix://${pd}/docker.sock`;
   if(args[2]==='version')return 'linux/arm64';
   throw Error('unexpected-docker-mutation');
  }
  if(bin==='colima') {
   expect(args.slice(0,2)).toEqual(['--profile',id.profile]);
   if(args[2]==='ssh') {
    expect(args.slice(3)).toEqual(['--','df','-Pk','/var/lib/docker']);
    if(state.badGuest) return 'unparseable';
    return `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vdb1 40000000 1 ${Math.floor(state.guest*1024**2)} 1% /var/lib/docker`;
   }
   if(args[2]==='stop'){if(state.stopFails)throw Error('already-stopped');return '';}
   if(args[2]==='delete') {
    expect(args.slice(3)).toEqual(['--force','--data']);
    if(state.deleteFails)throw Error('delete-failed');
    for(const p of [pd,ld,dd])rmSync(p,{recursive:true,force:true});return '';
   }
  }
  throw Error('unexpected-command');
 };
 const watch=async(bin:string,args:string[],opts:any)=>{
  calls.push({bin,args});opts.check();
  if(bin==='colima') {
   expect(args.slice(0,3)).toEqual(['--profile',id.profile,'start']);
   mkdirSync(ld,{recursive:true,mode:0o700});mkdirSync(dd,{recursive:true,mode:0o700});
   writeFileSync(join(ld,'lima.yaml'),JSON.stringify(state.mounts));
   writeFileSync(join(pd,'colima.yaml'),'owned profile');
   if(state.startFails)throw Error('partial-start');
   if(state.hostAfter!==undefined)state.host=state.hostAfter;
   if(state.changeContext)state.current='other';
  } else {
   expect(args.at(-1)).toBe('--profile-worker');
   const lease=JSON.parse(readFileSync(l.leaseFile,'utf8'));
   expect(lease.controllerPid).toBe(process.pid);expect(opts.env.LCM_PROFILE_CONTROLLER_NONCE).toBe(lease.nonce);
   if(state.driftDuringBuild)state.host=16.49;
   opts.check();
   if(state.buildFails)throw Error('build-failed');
  }
 };
 const l=lifecycle({env,home,run,hostFree:()=>state.host,memory:()=>state.memory,platform:'darwin',arch:'arm64',watch});
 return {home,workspace,env,id,pd,ld,dd,state,calls,l,run,watch};
}
const mutations=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.bin==='colima'&&['start','stop','delete'].includes(c.args[2]));
async function ready(f:ReturnType<typeof fixture>) {Object.assign(f.env,await f.l.start());}
describe('owned fresh builder lifecycle (fake Colima only)',()=>{
 it('canonical lease, exact CLI flags, RO mount, explicit context, 21 shared IDs unchanged, idempotent cleanup',async()=>{
  const f=fixture(),before=[...f.state.ids];await ready(f);
  expect(f.l.capacity()).toEqual({host:23,guest:36});
  const start=mutations(f)[0].args;
  for(const flag of ['--activate=false','--ssh-config=false','--template=false','--ssh-agent=false'])expect(start).toContain(flag);
  for(const [flag,value]of [['--cpus','2'],['--memory','3'],['--disk','40'],['--root-disk','20'],['--mount',f.workspace]])expect(start[start.indexOf(flag)+1]).toBe(value);
  expect(statSync(f.l.job).mode&0o777).toBe(0o700);expect(statSync(f.l.leaseFile).mode&0o777).toBe(0o600);
  const exports=readFileSync(f.env.GITHUB_ENV,'utf8');expect(exports).toContain('LCM_BUILDER_CONTEXT=colima-lcm-api-build-123-1');expect(exports).not.toMatch(/SECRET|TOKEN|SSH_AUTH/);
  await f.l.runImage(['build','--sha',f.id.sha]);
  const cache=join(f.home,'.colima/public-boot-cache');writeFileSync(cache,'public reusable blob');
  const proof=join(f.l.job,'archive-metadata.json');writeFileSync(proof,'small unique proof',{mode:0o600});
  f.l.teardown();f.l.teardown();expect(existsSync(f.pd)).toBe(false);expect(existsSync(f.ld)).toBe(false);expect(existsSync(f.dd)).toBe(false);
  expect(f.state.ids).toEqual(before);expect(f.state.current).toBe('colima');expect(readFileSync(cache,'utf8')).toBe('public reusable blob');
  expect(readFileSync(proof,'utf8')).toBe('small unique proof');
  expect(mutations(f).filter(c=>c.args[2]==='delete')).toHaveLength(1);
 });
 it.each([22.69,20.8,16,NaN])('startup below 22.7/unknown: %s -> zero CLI mutation',async free=>{
  const f=fixture();f.state.host=free;await expect(f.l.start()).rejects.toThrow();expect(mutations(f)).toEqual([]);expect(existsSync(f.l.job)).toBe(false);
 });
 it.each([3.99,NaN])('insufficient/unknown RAM %s -> zero CLI mutation',async mem=>{
  const f=fixture();f.state.memory=mem;await expect(f.l.start()).rejects.toThrow();expect(mutations(f)).toEqual([]);
 });
 it('unsupported CLI version refuses provisioning',async()=>{const f=fixture();f.state.version='colima version 0.9.0';await expect(f.l.start()).rejects.toThrow();expect(mutations(f)).toEqual([]);});
 it('preexisting context alias is never overwritten',async()=>{const f=fixture();f.state.foreignContext=true;await expect(f.l.start()).rejects.toThrow('preexisting-context');expect(mutations(f)).toEqual([]);});
 it.each(['wrongHead','dirty'])('source mismatch %s refuses provisioning',async failure=>{const f=fixture();f.state[failure]=true;await expect(f.l.start()).rejects.toThrow('workspace-source');expect(mutations(f)).toEqual([]);});
 it('never adopts a preexisting profile or job lease',async()=>{
  const f=fixture();mkdirSync(f.pd,{recursive:true});writeFileSync(join(f.pd,'foreign'),'keep');
  await expect(f.l.start()).rejects.toThrow('preexisting-builder');expect(mutations(f)).toEqual([]);expect(readFileSync(join(f.pd,'foreign'),'utf8')).toBe('keep');
 });
 it('CLI reports the exact refused namespace without deleting a foreign profile',()=>{
  const f=fixture();mkdirSync(f.pd,{recursive:true});writeFileSync(join(f.pd,'foreign'),'keep');
  const r=spawnSync(process.execPath,[new URL('./build-profile.mjs',import.meta.url).pathname,'teardown'],{encoding:'utf8',env:{...process.env,...f.env,HOME:f.home,COLIMA_HOME:'',COLIMA_PROFILE:'',LIMA_HOME:'',DOCKER_HOST:'',DOCKER_CONTEXT:'',DOCKER_CONFIG:''}});
  expect(r.status).toBe(1);expect(r.stderr).toContain(`profile=${f.id.profile}`);expect(r.stderr).toContain(f.l.leaseFile);expect(readFileSync(join(f.pd,'foreign'),'utf8')).toBe('keep');
 });
 it('atomic active lease refuses another builder without deleting its marker',async()=>{
  const f=fixture();mkdirSync(join(f.l.root,'active'),{recursive:true,mode:0o700});writeFileSync(join(f.l.root,'active/owner.json'),'foreign active lease');
  await expect(f.l.start()).rejects.toThrow();expect(mutations(f)).toEqual([]);expect(readFileSync(join(f.l.root,'active/owner.json'),'utf8')).toBe('foreign active lease');
 });
 it.each([{LCM_BUILDER_PROFILE:'default'},{LCM_BUILDER_CONTEXT:'colima-figuredeal'},{GITHUB_SHA:'HEAD'},{GITHUB_RUN_ID:'1; bad'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_ACTOR:'other'},{DOCKER_HOST:'tcp://foreign:2375'}])('rejects unsafe identity/routing %j',extra=>{
  const f=fixture();expect(()=>lifecycle({env:{...f.env,...extra},home:f.home})).toThrow();expect(mutations(f)).toEqual([]);
 });
 it('replayed/wrong marker prevents any stop/delete',async()=>{
  const f=fixture();await ready(f);writeFileSync(f.l.marker,JSON.stringify({...identity(f.env),version:1,sha:'a'.repeat(40)}));
  expect(()=>f.l.teardown()).toThrow('builder-marker');expect(mutations(f)).toHaveLength(1);
 });
 it('wrong lease SHA prevents cleanup',async()=>{
  const f=fixture();await ready(f);const lease=JSON.parse(readFileSync(f.l.leaseFile,'utf8'));writeFileSync(f.l.leaseFile,JSON.stringify({...lease,sha:'a'.repeat(40)}));
  expect(()=>f.l.teardown()).toThrow('lease-identity');expect(mutations(f)).toHaveLength(1);
 });
 it.each(['badGuest','lowGuest','hostAfter','startFails','mountHome','agent','changeContext','badEndpoint'])('failed startup %s -> own teardown, no image build',async failure=>{
  const f=fixture();if(failure==='lowGuest')f.state.guest=7.5;else if(failure==='hostAfter')f.state.hostAfter=20.79;else if(failure==='mountHome')f.state.mounts.mounts=[{location:'~',writable:true}];else if(failure==='agent')f.state.mounts.ssh.forwardAgent=true;else f.state[failure]=true;
  await expect(f.l.start()).rejects.toThrow();expect(existsSync(f.pd)).toBe(false);expect(existsSync(f.ld)).toBe(false);expect(existsSync(f.dd)).toBe(false);
  expect(mutations(f).some(c=>c.args[2]==='delete')).toBe(true);expect(f.calls.some(c=>c.args.includes('build'))).toBe(false);
 });
 it('failed stop after partial boot still force-deletes only the owned profile',async()=>{
  const f=fixture();f.state.startFails=true;f.state.stopFails=true;await expect(f.l.start()).rejects.toThrow();expect(existsSync(f.pd)).toBe(false);expect(mutations(f).at(-1)?.args[2]).toBe('delete');
 });
 it('failed delete preserves exact lease/marker and reports incomplete cleanup',async()=>{
  const f=fixture();await ready(f);f.state.deleteFails=true;expect(()=>f.l.teardown()).toThrow();expect(existsSync(f.pd)).toBe(true);expect(JSON.parse(readFileSync(f.l.leaseFile,'utf8')).stage).toBe('ready');
 });
 it('build failure or monitored host drift tears down own VM',async()=>{
  const f=fixture();await ready(f);f.state.driftDuringBuild=true;await expect(f.l.runImage(['build','--sha',f.id.sha])).rejects.toThrow();expect(existsSync(f.pd)).toBe(false);expect(f.state.ids).toHaveLength(21);
 });
 it('unknown measurement during build cannot grant continued execution',async()=>{
  const f=fixture();await ready(f);f.state.badGuest=true;await expect(f.l.runImage(['build','--sha',f.id.sha])).rejects.toThrow();expect(f.calls.some(c=>c.args.includes('--profile-worker'))).toBe(false);expect(existsSync(f.pd)).toBe(false);
 });
 it('fresh-only: same attempt cannot silently resume even after successful cleanup',async()=>{
  const f=fixture();await ready(f);f.l.teardown();await expect(f.l.start()).rejects.toThrow('preexisting-builder');
 });
 it('strict mount allowlist rejects private/home/rw/agent forwarding',()=>{
  const f=fixture();expect(()=>assertMounts(f.state.mounts,f.workspace)).not.toThrow();
  for(const bad of [{...f.state.mounts,mounts:[{location:f.workspace,writable:true}]},{...f.state.mounts,mounts:[{location:'~',writable:false}]},{...f.state.mounts,ssh:{forwardAgent:true,loadDotSSHPubKeys:false}}])expect(()=>assertMounts(bad,f.workspace)).toThrow();
 });
 it('parses a minimal generated Lima YAML with the installed safe data parser before checking actual RO/agent settings',()=>{
  const f=fixture(),p=join(f.home,'lima.yaml');
  writeFileSync(p,`mountType: virtiofs\nmounts:\n  - location: ${f.workspace}\n    writable: false\nssh:\n  forwardAgent: false\n  loadDotSSHPubKeys: false\n`);
  const r=spawnSync('ruby',['-ryaml','-rjson','-e','puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], aliases: false))',p],{encoding:'utf8'});
  expect(r.status).toBe(0);expect(()=>assertMounts(JSON.parse(r.stdout),f.workspace)).not.toThrow();
 });
 it('capacity parser uses data mount, not VM root, and rejects missing/zero values',()=>{
  expect(parseFree('Filesystem blocks used available cap mount\n/dev/vdb1 40000000 1 36000000 1% /var/lib/docker','/var/lib/docker')).toBeGreaterThan(20.8);
  for(const s of ['bad','Filesystem blocks used available cap mount\n/dev/vda1 19000000 1 18000000 1% /','Filesystem blocks used available cap mount\n/dev/vdb1 40000000 1 0 1% /var/lib/docker'])expect(()=>parseFree(s,'/var/lib/docker')).toThrow();
  expect(LIMITS).toEqual({startup:22.7,build:20.8,abort:16.5,memory:4});
 });
});
it('real process monitor terminates only its own child group on budget drift; unrelated child stays alive',async()=>{
 const p=mkdtempSync(join(tmpdir(),'lcm-monitor-'));roots.push(p);let n=0,ownedPid:number|undefined;
 const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 try {
  await expect(watchChild(process.execPath,['-e','process.stderr.write("PRIVATE_SYNTHETIC_CHILD");setInterval(()=>{},1000)'],{check:()=>{if(++n>2)throw Error('host-below-16.5');},interval:50,log:join(p,'private.log'),onSpawn:c=>{ownedPid=c.pid;}})).rejects.toThrow('owned-child-halted');
  expect(other.exitCode).toBe(null);expect(()=>process.kill(other.pid!,0)).not.toThrow();expect(()=>process.kill(ownedPid!,0)).toThrow();expect(statSync(join(p,'private.log')).mode&0o777).toBe(0o600);
 }finally{other.kill('SIGTERM');await new Promise(r=>other.once('exit',r));}
},10000);
it('cancellation of a real owned controller terminates its child group and returns a failure code',async()=>{
 const p=mkdtempSync(join(tmpdir(),'lcm-cancel-'));roots.push(p);const pidFile=join(p,'child.pid');
 const moduleUrl=new URL('./build-profile.mjs',import.meta.url).href;
 const script=`import {watchChild} from ${JSON.stringify(moduleUrl)};import{writeFileSync}from'node:fs';try{await watchChild(process.execPath,['-e','setInterval(()=>{},1000)'],{log:${JSON.stringify(join(p,'private.log'))},check:()=>{},interval:20,onSpawn:c=>writeFileSync(${JSON.stringify(pidFile)},String(c.pid))});}catch{process.exitCode=1;}`;
 const controller=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});let childPid;
 try {
  for(let i=0;i<100&&!existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,10));
  expect(existsSync(pidFile)).toBe(true);childPid=+readFileSync(pidFile,'utf8');
  const exited=new Promise(r=>controller.once('exit',r));controller.kill('SIGTERM');expect(await exited).toBe(1);
  expect(()=>process.kill(childPid,0)).toThrow();
 }finally{if(controller.exitCode===null&&controller.signalCode===null){controller.kill('SIGTERM');await new Promise(r=>controller.once('exit',r));}}
},10000);
