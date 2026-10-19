import {spawn} from 'node:child_process';
import {openSync,closeSync,createWriteStream,rmSync} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
export async function streamArchive({imageId,out,maxBytes,log,docker='docker',gzip='gzip',dockerPrefix=['--context','colima'],env=process.env}) {
 if(!/^sha256:[a-f0-9]{64}$/.test(imageId)||!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw Error('archive-input');
 // Exclusive creation: a failure may remove ONLY the file this call created.
 const err=openSync(log,'a',0o600);let fd;
 try{fd=openSync(out,'wx',0o600);}catch(e){closeSync(err);throw e;}
 let save,zip,bytes=0,ok=false,tasks=[];
 const output=createWriteStream(out,{fd,autoClose:true});
 output.on('error',()=>{});const closed=new Promise(res=>output.once('close',res));
 const digest=createHash('sha256');
 const done=p=>new Promise((res,rej)=>{p.once('error',()=>rej(Error('archive-child')));p.once('exit',code=>code===0?res(0):rej(Error('archive-child')));});
 try {
  save=spawn(docker,[...dockerPrefix,'save',imageId],{env,stdio:['ignore','pipe',err]});
  zip=spawn(gzip,['-n','-c'],{env,stdio:['pipe','pipe',err]});
  const cap=new Transform({transform(b,enc,cb){bytes+=b.length;if(bytes>maxBytes)return cb(Error('archive-cap'));digest.update(b);cb(null,b);}});
  tasks=[done(save),done(zip),pipeline(save.stdout,zip.stdin),pipeline(zip.stdout,cap,output)];
  await Promise.all(tasks);
  if(bytes<=0)throw Error('archive-empty');ok=true;return {bytes,sha256:digest.digest('hex')};
 }catch {throw Error('archive-stream-failed');}
 finally {
  if(!ok)output.destroy();
  const stopped=[];
  for(const p of [save,zip])if(p?.pid&&p.exitCode===null&&p.signalCode===null){stopped.push(new Promise(res=>p.once('exit',res)));p.kill('SIGTERM');}
  await Promise.allSettled([...tasks,...stopped]);await closed;
  closeSync(err);if(!ok)rmSync(out,{force:true});
 }
}
