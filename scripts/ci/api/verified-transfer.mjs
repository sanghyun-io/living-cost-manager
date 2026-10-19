import {spawn} from 'node:child_process';import{createWriteStream,openSync,closeSync,rmSync}from'node:fs';import{Transform}from'node:stream';import{pipeline}from'node:stream/promises';import{createHash}from'node:crypto';
export async function receiveVerified({bin,args,out,bytes,sha256,log}) {
 if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>1024**3||!/^[a-f0-9]{64}$/.test(sha256))throw Error('base-transfer-bound');
 const err=openSync(log,'a',0o600);let fd;try{fd=openSync(out,'wx',0o600);}catch(e){closeSync(err);throw e;}
 const output=createWriteStream(out,{fd,autoClose:true});output.on('error',()=>{});const closed=new Promise(r=>output.once('close',r));let child,ok=false,count=0;const h=createHash('sha256'),tasks=[];
 try {
  child=spawn(bin,args,{stdio:['ignore','pipe',err]});tasks.push(new Promise((res,rej)=>{child.once('error',()=>rej(Error('base-transfer-child')));child.once('exit',c=>c===0?res(0):rej(Error('base-transfer-child')));}));
  const cap=new Transform({transform(b,enc,cb){count+=b.length;if(count>bytes)return cb(Error('base-transfer-cap'));h.update(b);cb(null,b);}});
  tasks.push(pipeline(child.stdout,cap,output));await Promise.all(tasks);if(count!==bytes||h.digest('hex')!==sha256)throw Error('base-transfer-integrity');ok=true;
 }catch{throw Error('base-transfer-failed');}finally{if(!ok)output.destroy();if(child?.pid&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await Promise.allSettled(tasks);await closed;closeSync(err);if(!ok)rmSync(out,{force:true});}
}
