import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,readdirSync,rmSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {startPG,stopPG,pgArgs,privateRunner,rehearse} from './local-restore.mjs';
import {MIGRATION} from './constants.mjs';
const root=resolve(import.meta.dirname,'../../..');
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
it('actual PG16 custom dump -> isolated peer restore -> pinned Prisma migration -> data/history fingerprints -> cleanup',()=>{
 const base=mkdtempSync(join(tmpdir(),'lr-')), src=join(base,'p'),dst=join(base,'r'),backup=join(base,'b');
 mkdirSync(backup,{mode:0o700});
 const io=privateRunner(join(base,'private.log'));
 let stopped=false;
 try {
  // Small text+one synthetic cluster, never Docker, production URL, app or network.
  const free=spawnSync('df',['-Pk',base],{encoding:'utf8'}).stdout.split('\n')[1]?.trim().split(/\s+/)[3];
  expect(+free*1024).toBeGreaterThan(16.24*1024**3);
  const s=startPG(src,io.run);
  const schema=join(base,'prisma');mkdirSync(join(schema,'migrations'),{recursive:true});
  cpSync(join(root,'prisma/schema.prisma'),join(schema,'schema.prisma'));
  for(const e of readdirSync(join(root,'prisma/migrations'))) if(e!==MIGRATION.name)cpSync(join(root,'prisma/migrations',e),join(schema,'migrations',e),{recursive:true});
  const url=`postgresql://${s.osUsername}@localhost:${s.port}/${s.db}?host=${encodeURIComponent(s.socketDir)}&schema=lcm`;
  io.run(join(root,'node_modules/.bin/prisma'),['migrate','deploy',`--schema=${schema}/schema.prisma`],{env:{...process.env,DATABASE_URL:url},cwd:root});
  const probe=`const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.$queryRawUnsafe('SELECT current_database() db,current_schema() schema').then(r=>process.stdout.write(r[0].db+'|'+r[0].schema)).catch(()=>{process.exitCode=1}).finally(()=>p.$disconnect());`;
  expect(io.run(process.execPath,['-e',probe],{cwd:root,env:{...process.env,DATABASE_URL:url}})).toBe(s.db+'|lcm');
  expect(io.run(process.execPath,['-e',probe],{cwd:root,env:{...process.env,DATABASE_URL:url.replace('&schema=lcm','')}})).toBe(s.db+'|public');
  const query=(sql:string)=>io.run(join(s.pgBinDir,'psql'),[...pgArgs(s),'-d',s.db,'-XAt','-v','ON_ERROR_STOP=1','-c',sql]);
  // Actual PostgreSQL inet text semantics behind the production backup failure;
  // a literal tests this without adding TCP/trust or touching a customer DB.
  expect(query("SELECT '172.18.0.7'::inet::text || '|' || host('172.18.0.7'::inet)")).toBe('172.18.0.7/32|172.18.0.7');
  query(`INSERT INTO lcm."Workspace" (id,name,"updatedAt") VALUES ('synthetic','PRIVATE_ROW_SENTINEL',now())`);
  query(`INSERT INTO lcm."User" (id,email,name,"passwordHash","updatedAt") VALUES ('synthetic-user','synthetic@example.invalid','PRIVATE_USER_SENTINEL','synthetic-not-a-real-hash',now()); INSERT INTO lcm."Category" (id,"workspaceId",label) VALUES ('category','synthetic','synthetic'); INSERT INTO lcm."FixedCost" (id,"workspaceId",name,"categoryId","paymentMethodId",amount,"billingDay","updatedAt") VALUES ('cost','synthetic','PRIVATE_FINANCE_SENTINEL','category','synthetic',12345,7,now()); INSERT INTO lcm."WorkspacePlanningState" ("workspaceId","payloadJson","updatedAt") VALUES ('synthetic','{"synthetic":true}',now())`);
  const tables=query(`SELECT count(*) FROM pg_tables WHERE schemaname='lcm'`),mig=query('SELECT count(*) FROM lcm._prisma_migrations'),dbbytes=query('SELECT pg_database_size(current_database())');
  io.run(join(s.pgBinDir,'pg_dump'),[...pgArgs(s),'-d',s.db,'-Fc','-f',join(backup,'synthetic.dump')]);
  const dump=readFileSync(join(backup,'synthetic.dump'));
  writeFileSync(join(backup,'backup.manifest'),`dump=synthetic.dump\nsha256=${hash(dump)}\nbytes=${dump.length}\ndb=livingcost\nschema=lcm\ntables=${tables}\nmig_rows=${mig}\napplied=${mig}\ndb_bytes=${dbbytes}\n`,{mode:0o600});
  // Simulate starter succeeded but state output was lost: cleanup uses the
  const mf=join(backup,'backup.manifest');
  writeFileSync(mf,readFileSync(mf,'utf8')+`source=${'b'.repeat(40)}\nrun=123\nattempt=1\nimage=sha256:${'c'.repeat(64)}\ndbIdentity=livingcost|lcm|172.19.0.2|5432\nexpires=${Math.floor(Date.now()/1000)+3600}\n`);
  // exclusively owned known cluster paths, not a guessed stdout URL.
  unlinkSync(join(src,'state.json'));
  stopPG(src,io.run);stopped=true;
  const proof=rehearse({backupDir:backup,stateDir:dst,log:join(backup,'private.log'),sha:'b'.repeat(40),runId:'123',attempt:'1',root});
  expect(proof.verified).toBe('true');expect(proof.dumpSha).toBe(hash(dump));expect(proof.sqlSha).toBe(MIGRATION.sqlSha256);
  expect(existsSync(dst)).toBe(false);
  // Same restored snapshot: changing ANY old User/financial/planning column
  // must invalidate the proof; only the single new User.uiTheme is ignored.
  for(const sql of [`UPDATE lcm."User" SET name='mutated'`,`UPDATE lcm."FixedCost" SET amount=999`,`UPDATE lcm."WorkspacePlanningState" SET revision=99`]){
   const run=(bin:string,args:string[],opts:any={})=>{const out=io.run(bin,args,opts);if(args[0]==='migrate'){const st=JSON.parse(readFileSync(join(dst,'state.json'),'utf8'));io.run(join(st.pgBinDir,'psql'),[...pgArgs(st),'-d',st.db,'-XAt','-v','ON_ERROR_STOP=1','-c',sql]);}return out;};
   expect(()=>rehearse({backupDir:backup,stateDir:dst,log:join(backup,'private.log'),sha:'b'.repeat(40),runId:'123',attempt:'1',root},{run})).toThrow('local-restore-failed');expect(existsSync(dst)).toBe(false);
  }
  expect(()=>rehearse({backupDir:backup,stateDir:dst,log:join(backup,'private.log'),sha:'b'.repeat(40),runId:'123',attempt:'1',root},{stop:(dir:string,run:Function)=>{stopPG(dir,run);throw Error('stop-failed-after-success');}})).toThrow('local-cleanup-failed');
  expect(existsSync(dst)).toBe(false);
  // Even a valid hash cannot turn a non-restorable dump into a permission receipt.
  const bad=Buffer.from('PRIVATE_STDERR_SENTINEL invalid custom dump');
  writeFileSync(join(backup,'synthetic.dump'),bad);
  writeFileSync(join(backup,'backup.manifest'),readFileSync(join(backup,'backup.manifest'),'utf8').replace(hash(dump),hash(bad)).replace(`bytes=${dump.length}`,`bytes=${bad.length}`));
  expect(()=>rehearse({backupDir:backup,stateDir:dst,log:join(backup,'private.log'),sha:'b'.repeat(40),runId:'123',attempt:'1',root})).toThrow('local-restore-failed');
  expect(existsSync(dst)).toBe(false);
 } finally {
  try{if(!stopped)stopPG(src,io.run);stopPG(dst,io.run);}finally{io.close();rmSync(base,{recursive:true,force:true});}
 }
},120000);

function fakeBackup() {
 const b=mkdtempSync(join(tmpdir(),'lr-f-'));writeFileSync(join(b,'x.dump'),'dump');
 writeFileSync(join(b,'backup.manifest'),`dump=x.dump\nsha256=${hash(Buffer.from('dump'))}\nbytes=4\ndb=livingcost\nschema=lcm\ntables=24\nmig_rows=12\napplied=11\ndb_bytes=1024\n`);
 const mf=join(b,'backup.manifest');writeFileSync(mf,readFileSync(mf,'utf8')+`source=${'b'.repeat(40)}\nrun=123\nattempt=1\nimage=sha256:${'c'.repeat(64)}\ndbIdentity=livingcost|lcm|172.19.0.2|5432\nexpires=${Math.floor(Date.now()/1000)+3600}\n`);
 return b;
}
it.each(['missing-state','restore-exit','stop-failed','manifest-missing'])('fails closed with cleanup/no receipt: %s',mode=>{
 const b=fakeBackup(),stateDir=join(b,'state');let stopCalls=0;
 const opts={backupDir:b,stateDir,log:join(b,'private.log'),sha:'b'.repeat(40),runId:'123',attempt:'1',root};
 try {
  if(mode==='manifest-missing')unlinkSync(join(b,'backup.manifest'));
  const run=(bin:string)=>{if(bin==='df')return 'Filesystem blocks used available capacity mount\nfake 99999999 1 99999999 1% /';throw Error('CHILD_RAW_SENTINEL no ERROR keyword');};
  expect(()=>rehearse(opts,{run,start:()=>{mkdirSync(stateDir);if(mode!=='missing-state')writeFileSync(join(stateDir,'state.json'),JSON.stringify({db:'lcm_restore_test_db',socketDir:join(stateDir,'s'),port:54559,osUsername:process.env.USER,pgBinDir:'/fake'}));},stop:()=>{stopCalls++;rmSync(stateDir,{recursive:true,force:true});if(mode==='stop-failed')throw Error('CHILD_RAW_SENTINEL');}})).toThrow(mode==='stop-failed'?'local-cleanup-failed':'local-restore-failed');
  expect(stopCalls).toBe(mode==='manifest-missing'?0:1);expect(existsSync(stateDir)).toBe(false);
 } finally{rmSync(b,{recursive:true,force:true});}
});
it('nonzero child exit without ERROR text fails and raw stderr is private, never the thrown message',()=>{
 const b=mkdtempSync(join(tmpdir(),'lr-log-')),log=join(b,'private.log'),io=privateRunner(log);
 try {
  expect(()=>io.run(process.execPath,['-e','process.stderr.write("PRIVATE_CHILD_SENTINEL warning only");process.exit(7)'])).toThrow('child-failed');
  expect(readFileSync(log,'utf8')).toContain('PRIVATE_CHILD_SENTINEL');
 } finally{io.close();rmSync(b,{recursive:true,force:true});}
});
