// Persistent fake engine/SSH server, invoked by separate real Node CLI processes.
// Unsupported operations fail. No Docker, SSH, daemon or application is invoked.
import{readFileSync,writeFileSync,appendFileSync,existsSync}from'node:fs';import{join}from'node:path';import{createHash}from'node:crypto';import{spawn}from'node:child_process';
const root=process.env.LCM_CLI_FIXTURE,c=JSON.parse(readFileSync(join(root,'control.json'))),args=process.argv.slice(3),mode=process.argv[2];
const log=x=>appendFileSync(join(root,'commands.jsonl'),JSON.stringify({at:Date.now(),pid:process.pid,...x})+'\n');
const mark=n=>writeFileSync(join(root,n),'1');
const id=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
const stop=n=>process.once('SIGINT',()=>{mark(n);process.exit(130);});
const pause=()=>new Promise(r=>setTimeout(r,1800));
if(mode==='df'||mode==='colima') {
 const dip=c.mode==='transfer-dip'&&existsSync(join(root,'transfer-active'))||c.mode==='load-dip'&&existsSync(join(root,'load-active'));
 if(mode==='colima'&&args.join(' ')!=='--profile default ssh -- df -Pk /var/lib/docker')throw Error('fixture-colima-not-readonly');
 const free=(mode==='df'?(dip&&c.mode==='transfer-dip'?16:30):(dip&&c.mode==='load-dip'?2:12))*1024**2;
 console.log(`Filesystem blocks used available cap mount\n${mode==='df'?'/dev/mock':'/dev/vdb1'} 99999999 1 ${free} 1% ${mode==='df'?'/System/Volumes/Data':'/var/lib/docker'}`);
}else if(mode==='ssh') {
 const host=args.indexOf('gamja-oci');if(host<0)throw Error('fixture-ssh-host');
 const joined=args.slice(host+1).join(' ').replaceAll('/opt/livingcost',c.remoteRoot);
 log({mode,command:joined});stop('ssh-stopped');
 const p=spawn('sh',['-c',joined],{env:process.env,stdio:'inherit'});p.once('exit',(code,signal)=>{process.exitCode=code??1;});
}else if(mode==='server') {
 if(args[0]==='base-archive-manifest'){log({mode,op:args[0]});console.log(JSON.stringify(c.transport));}
 else if(args[0]==='base-archive-stream'){
  log({mode,op:args[0]});const b=readFileSync(join(root,'base-code.bin'));stop('transfer-stopped');
  if(c.mode==='transfer-dip'){process.stdout.write(b.subarray(0,3));mark('transfer-active');await pause();process.stdout.write(b.subarray(3));}else process.stdout.write(b);
 }else throw Error('fixture-server-operation');
}else if(mode==='docker') {
 if(args.slice(0,4).join('|')!==['--config',c.clientDir,'--context','colima'].join('|'))throw Error('fixture-wrong-private-context');
 const a=args.slice(4),cmd=a[0],last=a.at(-1),after=f=>a[a.indexOf(f)+1];log({mode,args:a});
 const file=join(root,'engine.json'),s=JSON.parse(readFileSync(file));
 const readonly=['context','version','info','exec'].includes(cmd)||['image','container','network'].includes(cmd)&&['ls','inspect'].includes(a[1]);
 const save=x=>{if(!readonly)writeFileSync(file,JSON.stringify(s));if(x!==undefined)console.log(typeof x==='string'?x:JSON.stringify(x));};
 const labels=()=>Object.fromEntries(a.flatMap((v,i)=>v==='--label'?[a[i+1].split(/=(.*)/s).slice(0,2)]:[]));
 if(cmd==='context')save(`unix://${c.home}/.colima/default/docker.sock`);
 else if(cmd==='version')save('linux/arm64');else if(cmd==='info')save('/var/lib/docker');
 else if(['image','container','network'].includes(cmd)&&a[1]==='ls'){
  if(a.includes('--quiet'))save(Object.values(s.image).map(x=>x.Id).join('\n'));
  else{const f=after('--filter'),name=f?.startsWith('reference=')?f.slice(10):f?.replace(/^name=\^\/?/,'').replace(/\$$/,'');save(s[cmd][name]?(last==='{{.Size}}'?'640MB':name):'');}
 }else if(['image','container','network'].includes(cmd)&&a[1]==='inspect'){if(!s[cmd][a[2]])process.exit(1);save(s[cmd][a[2]]);}
 else if(cmd==='load'){
  if(!existsSync(after('-i')))throw Error('fixture-load-missing-verified-file');stop('load-stopped');
  if(c.mode==='load-dip'){mark('load-active');await pause();}
  s.image[c.transport.imageId]=c.baseImage;save('Loaded image ID: '+c.transport.imageId);
 }else if(cmd==='tag'){if(!s.image[a[1]]||s.image[a[2]])throw Error('fixture-tag-identity');s.image[a[2]]=s.image[a[1]];save();}
 else if(cmd==='buildx'&&a[1]==='build'){
  if(after('--builder')!=='colima'||after('--network')!=='none'||!a.includes('--load'))throw Error('fixture-overlay-builder');
  if(c.mode==='build-error'){process.stderr.write('ERROR: public-code-build-error PRIVATE_BUILD_STDERR_SENTINEL\n');process.exit(1);}
  const m=JSON.parse(readFileSync(join(last,'bundle/bundle.json')));if(m.source!==process.env.GITHUB_SHA)throw Error('fixture-build-source');
  const tag=after('-t');if(s.image[tag])throw Error('fixture-build-preexisting');
  s.image[tag]={Id:id(tag),Size:160000000,Os:'linux',Architecture:'arm64',Config:{Labels:{...labels(),'org.opencontainers.image.revision':m.source,'lcm.runtime-baseline':c.transport.imageId,'lcm.compiled-bundle':m.bundleSha256}}};save();
 }else if(cmd==='network'&&a[1]==='create'){if(s.network[last])throw Error('fixture-network-collision');s.network[last]={Id:id(last),Labels:labels()};save(s.network[last].Id);}
 else if(cmd==='run'){
  const name=after('--name');if(!name||s.container[name])throw Error('fixture-container-collision');
  log({mode:'container-created',name,labels:labels()});
  if(a.includes('--rm')){
   if(last==='audit'){
    const source=readFileSync(0);if(createHash('sha256').update(source).digest('hex')!==c.transport.auditSha256)throw Error('fixture-audit-source');save(c.transport.audit);
   }else if(last==='verify-installed')save();
   else if(last==='smoke'){s.planningSmoke={create:true,update:true,find:true,revision:2};save();}
   else if(a.includes('sha256sum'))save('1ba3540c796a3e198803a6b9e3c49c60ae300adb5e329505cd25f5be9e06386b  migration.sql');
   else if(last==="ls prisma/migrations | grep -c '^20'")save('13');
   else if(last==='./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma'){s.migrated=true;save();}
   else throw Error('fixture-unhandled-probe');
  }else{s.container[name]={Id:id(name),Labels:labels()};save(s.container[name].Id);}
 }else if(cmd==='exec'){
  if(!Object.values(s.container).some(x=>x.Id===a[1]))throw Error('fixture-exec-not-owned-id');
  if(a[2]==='du')save(`${c.mode==='pg-overcap'?262145:20480} /var/lib/postgresql/data`);
  else if(a[2]==='node'){if(!s.migrated||!s.planningSmoke)throw Error('fixture-health-before-planning');if(last.includes('.apiSmoke()')){mark('theme-api-smoke');save();}else save({commitSha:process.env.GITHUB_SHA,releaseId:'synthetic-overlay'});}
  else if(last==='SELECT 1')save('1');else if(last==='CREATE SCHEMA IF NOT EXISTS lcm')save();else throw Error('fixture-unhandled-exec');
 }else if(cmd==='rm'||a[1]==='rm'){
  const kind=cmd==='rm'?'container':cmd,target=last;for(const [name,x]of Object.entries(s[kind]))if(name===target||x.Id===target){if(name==='foreign-container'||name==='foreign-network'||name==='foreign-image')throw Error('fixture-foreign-mutation');delete s[kind][name];}save();
 }else if(cmd==='save'){
  if(!Object.values(s.image).some(x=>x.Id===last&&x.Config.Labels['org.opencontainers.image.revision']===process.env.GITHUB_SHA))throw Error('fixture-save-not-candidate');
  process.stdout.write('synthetic source-bound candidate image bytes');
 }else throw Error('fixture-unsupported-docker-operation');
}else throw Error('fixture-operation');
