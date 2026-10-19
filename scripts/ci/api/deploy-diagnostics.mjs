// Failed deploy stderr only, bounded and private. NEVER persist child stdout:
// it may be a customer dump or an untrusted error body.
import {mkdirSync,lstatSync,realpathSync,openSync,writeSync,closeSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
const details=new Set(['db-identity-mismatch','db-identity-probe','sealed-env-missing','candidate-image-not-loaded','candidate-image-drift','pg_dump-failed','dump-size-invalid','db-size-query','db-size-invalid','capacity-measure-failed','capacity-parse-failed','capacity-peak-not-met','oci-capacity-below-floor','oci-capacity-insufficient-for-backup','staging-mkdir-failed','staging-chmod-failed','staging-chown-failed','staging-mode-not-700','mktemp-failed','db-query-failed','unexpected-shell-failure']);
export function helperHalt(stdout,operation) {
 if(typeof stdout!=='string'||!/^[a-z][a-z-]{0,40}$/.test(operation))return null;
 const lines=stdout.trim().split('\n');if(lines.length!==1)return null;
 const m=new RegExp(`^op=${operation} result=halt code=(2[0-9]) detail=([a-z0-9_-]+)$`).exec(lines[0]);
 return m&&details.has(m[2])?{code:+m[1],detail:m[2]}:null;
}
export function saveDeployFailure({home,key,operation,exitCode,stderr,stdout,binary=false,parseHelper=false}) {
 if(!/^[1-9][0-9]{0,14}-[1-9][0-9]{0,3}-[a-f0-9]{40}$/.test(key)||!/^[a-z][a-z-]{0,40}$/.test(operation))throw Error('diagnostic-identity');
 const dir=join(home,'.local/state/lcm-api-deploy-diagnostics',key);let p=home;
 for(const n of dir.slice(home.length+1).split('/')){p=join(p,n);try{mkdirSync(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o022)||realpathSync(p)!==resolve(p))throw Error('diagnostic-owner');}
 const halt=!binary&&parseHelper?helperHalt(stdout,operation):null;
 const fd=openSync(join(dir,'failed-stderr.log'),constants.O_CREAT|constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
 try{const s=lstatSync(join(dir,'failed-stderr.log'));if(s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw Error('diagnostic-mode');
  writeSync(fd,JSON.stringify({kind:'deploy-child-failure',operation,exitCode,halt,stdoutLogged:false})+'\n');
  const b=Buffer.isBuffer(stderr)?stderr:Buffer.from(stderr??'');writeSync(fd,b.subarray(Math.max(0,b.length-65536)));writeSync(fd,'\n');
 }finally{closeSync(fd);}
 return `op=${operation} exit=${Number.isInteger(exitCode)?exitCode:'unavailable'}${halt?` halt=${halt.code} detail=${halt.detail}`:''} diagnostics=protected`;
}
