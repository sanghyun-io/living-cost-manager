// Trusted owner workflow orchestrator. SSH always receives ONE quoted command;
// raw subprocess diagnostics never enter Actions output.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,rmSync,lstatSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {PROD,SHA_RE,IMAGE_NAME} from './constants.mjs';
import {validateMetadata} from './metadata.mjs';
import {rehearse,parseManifest,localTools} from './local-restore.mjs';
import {verifyBase,compatibility} from './runtime-overlay.mjs';
import {receiveVerified} from './verified-transfer.mjs';
import {saveDeployFailure} from './deploy-diagnostics.mjs';
import {homedir} from 'node:os';
const args=process.argv.slice(2),cmd=args[0];
const flag=n=>{const i=args.indexOf(`--${n}`);return i<0?undefined:args[i+1]};
const need=n=>{const v=flag(n);if(!v)throw Error('missing-argument');return v};
const hash=b=>createHash('sha256').update(b).digest('hex');
const quote=s=>`'${String(s).replaceAll("'","'\\''")}'`;
const remoteCommand=parts=>parts.map(quote).join(' ');
function child(bin,a,opts={}) {
 const {operation='local-command',parseHelper=false,...spawnOpts}=opts;
 const r=spawnSync(bin,a,{encoding:'utf8',...spawnOpts});
 if(r.status!==0){
  let summary=`op=${operation} diagnostics=protected`;
  try{const i=identity();summary=saveDeployFailure({home:homedir(),key:`${i.run}-${i.attempt}-${i.sha}`,operation,exitCode:r.status,stderr:r.stderr,stdout:r.stdout,binary:spawnOpts.encoding===null,parseHelper});}catch{}
  const e=Error('deploy-child-failed');e.summary=summary;throw e;
 } return r.stdout;
}
function ssh(parts,input,encoding='utf8',diagnostics={}) {
 return child(process.env.LCM_SSH_BIN??'ssh',['-o','BatchMode=yes',PROD.host,remoteCommand(parts)],{input,encoding,maxBuffer:4*1024**3,operation:encoding===null?'binary-transfer':'ssh-command',...diagnostics});
}
function identity(){
 const sha=need('sha'),run=need('run'),attempt=need('attempt');
 if(!SHA_RE.test(sha)||!/^[1-9][0-9]{0,14}$/.test(run)||!/^[1-9][0-9]{0,3}$/.test(attempt)) throw Error('invalid-identity');
 return {sha,run,attempt,dir:`${PROD.backupsRoot}/actions-${run}-${attempt}-${sha.slice(0,12)}`};
}
function op(name,id,extra=[],input) {
 const out=ssh(['sudo','bash',`${id.dir}/deploy-host.sh`,name,'--sha',id.sha,'--run',id.run,'--attempt',id.attempt,...extra],input,'utf8',{operation:name,parseHelper:true});
 // No arbitrary helper stdout, even on failures.
 console.log(`api-deploy: ${name} ok`);return out;
}
function servingReference(id) {
 const m=JSON.parse(ssh(['sudo','bash',id.dir+'/deploy-host.sh','serving-reference','--sha',id.sha,'--run',id.run,'--attempt',id.attempt]));
 const old=m.source===PROD.currentReleaseSha&&m.reference===PROD.currentComposeImageRef&&m.imageId===PROD.currentImageId;
 const current=m.source===id.sha&&m.reference===`${PROD.newComposeImageTagPrefix}${id.sha}:candidate`&&/^sha256:[a-f0-9]{64}$/.test(m.imageId??'');
 if(!old&&!current)throw Error('serving-reference-binding');return m;
}
function officialConfig(tmpDir) {
 const bin=process.env.OPS_KV_BIN??'opskv',key='/living-cost-manager/production/BACKEND_IMAGE';
 const j=JSON.parse(child(bin,['show',key],{operation:'opskv-show'})),meta=j.data??j,version=String(meta.version??'');
 if(meta.kind!=='config'||!/^[1-9][0-9]*$/.test(version))throw Error('opskv-metadata');
 mkdirSync(tmpDir,{recursive:true,mode:0o700});const ds=lstatSync(tmpDir);if(ds.isSymbolicLink()||ds.uid!==process.getuid())throw Error('opskv-directory');chmodSync(tmpDir,0o700);
 const f=join(tmpDir,`backend-image-current-${randomBytes(8).toString('hex')}.value`);
 try{child(bin,['get',key,'--output',f],{operation:'opskv-get'});const s=lstatSync(f);if(s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw Error('opskv-value-owner');const reference=readFileSync(f,'utf8').trim();return {bin,key,version,reference};}finally{rmSync(f,{force:true});}
}
try {
 if(cmd==='verify-public') {
  const sha=need('sha');if(!SHA_RE.test(sha))throw Error('invalid-identity');
  let ok=false;
  for(let i=0;i<10;i++) {
   try {if(JSON.parse(child(process.env.LCM_CURL_BIN??'curl',['-fsS','--max-time','10',PROD.publicHealthUrl])).commitSha===sha){ok=true;break;}}catch{}
   child('sleep',['15']);
  }
  if(!ok)throw Error('identity mismatch');
 } else if(cmd==='cleanup-copy') {
  const dir=need('out-dir');
  if(dir!==join(process.env.GITHUB_WORKSPACE??process.cwd(),'.lcm-offhost-backup'))throw Error('cleanup-path');
  rmSync(dir,{recursive:true,force:true});
 } else {
  const id=identity();
  if(cmd==='check-local-tools') {
   localTools();
  } else if(cmd==='install-helper') {
   const src=readFileSync(new URL('./deploy-host.sh',import.meta.url));
   ssh(['sudo','install','-d','-m','700',id.dir]);
   ssh(['sudo','bash','-c',`umask 077; cat > ${quote(id.dir+'/deploy-host.sh')}; chmod 0500 ${quote(id.dir+'/deploy-host.sh')}`],src,null);
   if(ssh(['sudo','sha256sum',id.dir+'/deploy-host.sh']).trim().split(/\s+/)[0]!==hash(src))throw Error('helper hash mismatch');
   for(const name of ['runtime-overlay.cjs','Dockerfile.runtime-overlay']){const data=readFileSync(new URL('./'+name,import.meta.url));ssh(['sudo','bash','-c',`umask 077; cat > ${quote(id.dir+'/'+name)}; chmod 0500 ${quote(id.dir+'/'+name)}`],data,null);if(ssh(['sudo','sha256sum',id.dir+'/'+name]).trim().split(/\s+/)[0]!==hash(data))throw Error('helper hash mismatch');}
   op('install-check',id);
  } else if(cmd==='fetch-base-metadata'||cmd==='fetch-runtime-base') {
   const auditSha=hash(readFileSync(new URL('./runtime-overlay.cjs',import.meta.url))),operation=cmd==='fetch-base-metadata'?'base-inspect':'base-archive-manifest';
   const parts=['sudo','bash',id.dir+'/deploy-host.sh',operation,'--sha',id.sha,'--run',id.run,'--attempt',id.attempt,'--audit-sha',auditSha];
   const meta=JSON.parse(ssh(parts));verifyBase(meta,cmd==='fetch-runtime-base');if(meta.auditSha256!==auditSha||meta.forSource!==id.sha||meta.run!==id.run||meta.attempt!==id.attempt)throw Error('base-metadata-binding');
   const dir=need('out-dir');mkdirSync(dir,{mode:0o700});writeFileSync(join(dir,'metadata.json'),JSON.stringify(meta),{mode:0o600,flag:'wx'});
   if(cmd==='fetch-runtime-base') {
    const stream=['sudo','bash',id.dir+'/deploy-host.sh','base-archive-stream','--sha',id.sha,'--run',id.run,'--attempt',id.attempt,'--archive-sha',meta.archiveSha256];
    await receiveVerified({bin:process.env.LCM_SSH_BIN??'ssh',args:['-o','BatchMode=yes',PROD.host,remoteCommand(stream)],out:join(dir,'base.tar.gz'),bytes:meta.archiveBytes,sha256:meta.archiveSha256,log:join(dir,'private-transfer.log')});
   }
  } else if(cmd==='send-archive') {
   const m=JSON.parse(readFileSync(need('metadata'),'utf8')),archive=readFileSync(need('archive'));
   validateMetadata(m,id.sha);
   if(m.buildKind==='runtime-overlay'&&(m.dependencyProofSha256!==compatibility(process.cwd()).sha256||m.baselineSafetySha256!==hash(readFileSync(new URL('./runtime-overlay.cjs',import.meta.url)))||m.overlayRecipeSha256!==hash(readFileSync(new URL('./Dockerfile.runtime-overlay',import.meta.url)))))throw Error('overlay-source-binding');
   if(m.runId!==id.run||m.runAttempt!==id.attempt||archive.length!==m.archiveBytes||hash(archive)!==m.archiveSha256)throw Error('archive-binding');
   // Capacity check BEFORE transfer, including compressed copy and uncompressed load.
   op('transfer-capacity',id,['--archive-bytes',String(m.archiveBytes),'--image-bytes',String(m.imageBytes)]);
   ssh(['sudo','bash','-c',`umask 077; cat > ${quote(id.dir+'/image.tar.gz')}`],archive,null);
   op('load-image',id,['--image-id',m.imageId,'--archive-sha',m.archiveSha256,'--archive-bytes',String(m.archiveBytes),'--image-bytes',String(m.imageBytes),'--build-kind',m.buildKind],JSON.stringify(m));
  } else if(cmd==='fetch-backup-copy') {
   const dir=need('out-dir');
   const text=ssh(['sudo','cat',id.dir+'/backup.manifest']);
   const m=parseManifest(text);
   // Exclusive fresh protected directory; never follow a stale workspace link.
   mkdirSync(dir,{mode:0o700});
   const free=Number(child('df',['-Pk',dir]).split('\n')[1]?.trim().split(/\s+/)[3]);
   const peak=Math.max(.2*1024**3,Number(m.bytes)*3+Number(m.db_bytes)*2);
   if(!Number.isFinite(free)||free*1024<16*1024**3+peak*1.2)throw Error('copy-capacity');
   const b=ssh(['sudo','cat',`${id.dir}/${m.dump}`],undefined,null);
   if(b.length!==+m.bytes||hash(b)!==m.sha256)throw Error('backup-integrity');
   writeFileSync(join(dir,m.dump),b,{mode:0o600,flag:'wx'});
   writeFileSync(join(dir,'backup.manifest'),text,{mode:0o600,flag:'wx'});
  } else if(cmd==='fetch-and-rehearse-local') {
   const backupDir=need('backup-dir'), stateDir=need('state-dir');
   const proof=rehearse({backupDir,stateDir,log:join(backupDir,'private-restore.log'),sha:id.sha,runId:id.run,attempt:id.attempt});
   // Only after actual restore, migration invariants AND successful cleanup.
   op('accept-local-restore',id,[],Object.entries(proof).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
   writeFileSync(join(backupDir,'restore-proof.json'),JSON.stringify(proof)+'\n',{mode:0o600});
   const m=parseManifest(readFileSync(join(backupDir,'backup.manifest'),'utf8'));
   rmSync(join(backupDir,m.dump));rmSync(join(backupDir,'private-restore.log'));
  } else if(cmd==='register-opskv'||cmd==='preflight-opskv') {
   const observed=servingReference(id),dir=need('tmp-dir'),kv=officialConfig(dir);
   if(cmd==='preflight-opskv'){if(kv.reference!==observed.reference)throw Error('opskv-reference-mismatch');}
   else {
    if(observed.source!==id.sha)throw Error('opskv-requires-promoted-source');
    const publicHealth=JSON.parse(child(process.env.LCM_CURL_BIN??'curl',['-fsS','--max-time','10',PROD.publicHealthUrl],{operation:'public-health'}));if(publicHealth.commitSha!==id.sha)throw Error('public-health-reference');
    if(kv.reference!==observed.reference){
     if(kv.reference!==PROD.currentComposeImageRef)throw Error('opskv-reference-mismatch');
     const f=join(dir,'backend-image.value');writeFileSync(f,observed.reference+'\n',{mode:0o600,flag:'wx'});
     try {child(kv.bin,['set','--expected-version',kv.version,'--kind','config','--value-file',f,kv.key],{operation:'opskv-set'});}finally{rmSync(f,{force:true});}
    }
   }
  } else if(['preflight','ensure-rollback','backup','rehearse','migrate','promote','verify','cleanup-job'].includes(cmd))op(cmd,id);
  else throw Error('unknown-command');
 }
 console.log('api-deploy: ok');
} catch(e) {
 // Error messages are fixed internal codes; child stderr/stdout is discarded.
 console.error(`api-deploy: halted ${e.message==='deploy-child-failed'?e.summary:['helper hash mismatch','identity mismatch','local-restore-failed','local-cleanup-failed','opskv-reference-mismatch','opskv-metadata'].includes(e.message)?e.message:'gate-failed'}`);
 process.exitCode=1;
}
