// Code-image child diagnostics ONLY. Never used for customer restore/env logs.
import {spawnSync} from 'node:child_process';
import {constants,openSync,closeSync,fstatSync,writeSync,writeFileSync} from 'node:fs';
export const OPERATIONS=Object.freeze(['overlay-build','linux-build','base-transfer','image-load','image-audit','synthetic-exec','image-operation','local-child']);
export function operationFor(bin,args) {
 if(bin==='docker') {
  if(args.includes('buildx')&&args.includes('build'))return 'overlay-build';
  if(args.includes('build'))return 'linux-build';
  if(args.includes('load'))return 'image-load';
  if(args.includes('audit'))return 'image-audit';
  if(args.includes('exec'))return 'synthetic-exec';
  return 'image-operation';
 }
 return args.includes('fetch-runtime-base')?'base-transfer':'local-child';
}
export function failureSummary(record) {
 if(!record||!OPERATIONS.includes(record.operation)||!(record.exitCode===null||Number.isInteger(record.exitCode)))return 'monitored operation halted; diagnostics=protected';
 return `operation=${record.operation} child-exit=${record.exitCode??'unavailable'} diagnostics=protected`;
}
export function protectedRun(bin,args,{log,failureFile,operation=operationFor(bin,args),allowFail=false,...opts}) {
 if(!OPERATIONS.includes(operation))throw Error('diagnostic-operation');
 const fd=openSync(log,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
 try {
  const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw Error('diagnostic-log-owner');
  writeSync(fd,JSON.stringify({kind:'code-image-child',operation,at:new Date().toISOString()})+'\n');
  const r=spawnSync(bin,args,{encoding:'utf8',maxBuffer:8*1024**2,...opts,stdio:['pipe','pipe',fd]});
  if(r.status!==0&&!allowFail) {
   // Some tools report failures on stdout; preserve privately, never echo it.
   if(r.stdout)writeSync(fd,r.stdout);
   const record={kind:'code-image-child-failure',operation,exitCode:r.status,signal:r.signal??null,spawnErrorCode:r.error?.code??null};
   writeSync(fd,'\n'+JSON.stringify(record)+'\n');
   writeFileSync(failureFile,JSON.stringify(record)+'\n',{mode:0o600});
  }
  return r;
 }finally{closeSync(fd);}
}
