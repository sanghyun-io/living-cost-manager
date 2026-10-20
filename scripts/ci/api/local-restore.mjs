// No application is started. All subprocess output is private; callers emit fixed codes only.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,openSync,closeSync,chmodSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {userInfo} from 'node:os';
import {createHash} from 'node:crypto';
import {MIGRATION} from './constants.mjs';
import {createRequire} from 'node:module';
const hash = b => createHash('sha256').update(b).digest('hex');
export function localTools(root=process.cwd()) {
  const cli=join(root,'node_modules/.bin/prisma');
  const req=createRequire(join(root,'node_modules/prisma/package.json'));
  const locked=readFileSync(join(root,'pnpm-lock.yaml'),'utf8').match(/\s+prisma:\n\s+specifier:[^\n]+\n\s+version: ([0-9.]+)/)?.[1];
  if(!locked || JSON.parse(readFileSync(join(root,'node_modules/prisma/package.json'),'utf8')).version!==locked)throw Error('local-cli-pin');
  const engine=join(req('@prisma/engines').getEnginesPath(),'schema-engine-darwin-arm64');
  if(!existsSync(cli) || !existsSync(engine))throw Error('local-cli-missing');
  return {cli,engine};
}
export function parseManifest(text) {
  const m={};
  for(const line of text.trim().split('\n')) { const i=line.indexOf('='); if(i<1 || m[line.slice(0,i)]!==undefined) throw Error('manifest'); m[line.slice(0,i)]=line.slice(i+1); }
  if(!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.dump$/.test(m.dump??'') || !/^[a-f0-9]{64}$/.test(m.sha256??'') || m.db!=='livingcost' || m.schema!=='lcm') throw Error('manifest');
  for(const k of ['bytes','tables','mig_rows','applied','db_bytes']) if(!/^[1-9][0-9]*$/.test(m[k]??'') || !Number.isSafeInteger(Number(m[k]))) throw Error('manifest');
  if(+m.bytes>1024**3) throw Error('manifest');
  return m;
}
export function privateRunner(log) {
  const fd=openSync(log,'a',0o600); chmodSync(log,0o600);
  return {close:()=>closeSync(fd), run(bin,args,opts={}) {
    const r=spawnSync(bin,args,{encoding:'utf8',...opts,stdio:['pipe','pipe',fd]});
    if(r.status!==0) throw Error('child-failed');
    return r.stdout.trim();
  }};
}
export function startPG(dir, run, pg=process.env.LCM_CI_PG_BIN_DIR??'/opt/homebrew/opt/postgresql@16/bin') {
  mkdirSync(dir,{mode:0o700});
  const s={dataDir:join(dir,'data'),socketDir:join(dir,'s'),port:54559,osUsername:userInfo().username,pgBinDir:pg,db:'lcm_restore_test_db'};
  mkdirSync(s.socketDir,{mode:0o700});
  // State is written BEFORE starting: cleanup can stop a partially successful pg_ctl.
  writeFileSync(join(dir,'state.json'),JSON.stringify(s),{mode:0o600});
  run(join(pg,'initdb'),['-D',s.dataDir,'-U',s.osUsername,'--auth-local=peer','--auth-host=reject','-E','UTF8']);
  run(join(pg,'pg_ctl'),['-D',s.dataDir,'-l',join(dir,'pg.log'),'-w','-t','30','start','-o',`-c listen_addresses='' -c unix_socket_directories='${s.socketDir}' -c port=${s.port} -c fsync=off`]);
  chmodSync(join(dir,'pg.log'),0o600);
  run(join(pg,'createdb'),[...pgArgs(s),s.db]);
  return s;
}
export const pgArgs=s=>['-h',s.socketDir,'-p',String(s.port),'-U',s.osUsername];
export function stopPG(dir, run) {
  if(!existsSync(dir)) return;
  if(lstatSync(dir).isSymbolicLink() || lstatSync(dir).uid!==process.getuid()) throw Error('cleanup-owner');
  // Caller exclusively created this directory; recover known paths even if a
  // successful starter failed to return/write parseable state metadata.
  let s;
  try {s=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));} catch {
    s={dataDir:join(dir,'data'),socketDir:join(dir,'s'),pgBinDir:process.env.LCM_CI_PG_BIN_DIR??'/opt/homebrew/opt/postgresql@16/bin'};
  }
  if(s.dataDir!==join(dir,'data') || s.socketDir!==join(dir,'s')) throw Error('cleanup-state');
  if(existsSync(join(s.dataDir,'postmaster.pid'))) run(join(s.pgBinDir,'pg_ctl'),['-D',s.dataDir,'-w','-t','30','stop','-m','fast']);
  rmSync(dir,{recursive:true,force:true});
}
// Each row is hashed IN PostgreSQL; no customer rows are returned or logged.
export function fingerprint(s,run,ignoreTheme=true) {
  const q=sql=>run(join(s.pgBinDir,'psql'),[...pgArgs(s),'-d',s.db,'-XAt','-v','ON_ERROR_STOP=1','-c',sql]);
  const names=JSON.parse(q(`SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='lcm' AND tablename<>'_prisma_migrations'`));
  // Canonical JSONB of ALL existing columns, excluding exactly the one new
  // approved field. User rows and planning/financial tables remain covered.
  const rows=names.map(n=>[n,q(`SELECT md5(coalesce(string_agg(h,',' ORDER BY h),'')) FROM (SELECT md5((${n==='User'&&ignoreTheme?"to_jsonb(t)-'uiTheme'":"to_jsonb(t)"})::text) h FROM lcm."${n.replaceAll('"','""')}" t) x`)]);
  const structure=q(`SELECT md5(string_agg(row_to_json(c)::text,',' ORDER BY table_name,ordinal_position)) FROM information_schema.columns c WHERE table_schema='lcm'${ignoreTheme?" AND NOT (table_name='User' AND column_name='uiTheme')":""}`);
  const constraints=q(`SELECT md5(string_agg(pg_get_constraintdef(c.oid),',' ORDER BY c.conname,c.conrelid::regclass::text)) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace JOIN pg_class r ON r.oid=c.conrelid WHERE n.nspname='lcm'${ignoreTheme?" AND NOT (r.relname='User' AND c.conname='User_uiTheme_check')":""}`);
  const history=q(`SELECT coalesce(json_agg(t ORDER BY migration_name,id),'[]') FROM lcm._prisma_migrations t WHERE migration_name<>'${MIGRATION.name}'`);
  return {proof:hash(JSON.stringify({rows,structure,constraints,history})),tables:+q(`SELECT count(*) FROM pg_tables WHERE schemaname='lcm'`),history:+q('SELECT count(*) FROM lcm._prisma_migrations'),applied:+q('SELECT count(*) FROM lcm._prisma_migrations WHERE finished_at IS NOT NULL'),theme:q(`SELECT count(*)=1 FROM information_schema.columns WHERE table_schema='lcm' AND table_name='User' AND column_name='uiTheme'`)==='t'};
}
export function rehearse({backupDir,stateDir,log,sha,runId,attempt,root=process.cwd()}, deps={}) {
  if(existsSync(stateDir)) throw Error('local-state-already-exists');
  const io=privateRunner(log); const run=deps.run??io.run;
  let proof, failure,started=false;
  try {
    const tools=localTools(root);
    const m=parseManifest(readFileSync(join(backupDir,'backup.manifest'),'utf8'));
    if(m.source!==sha||m.run!==runId||m.attempt!==attempt||!/^sha256:[a-f0-9]{64}$/.test(m.image??'')||!/^livingcost\|lcm\|[0-9.]+\|5432$/.test(m.dbIdentity??'')||!/^\d{10}$/.test(m.expires??'')||+m.expires<=Date.now()/1000)throw Error('manifest-target-binding');
    const dump=readFileSync(join(backupDir,m.dump));
    if(dump.length!==+m.bytes || hash(dump)!==m.sha256) throw Error('dump-integrity');
    const free=run('df',['-Pk',backupDir]).split('\n')[1]?.trim().split(/\s+/)[3];
    const peak=Math.max(.2*1024**3,dump.length*3+Number(m.db_bytes)*2);
    if(!Number.isFinite(+free) || +free*1024 < 16*1024**3+peak*1.2) throw Error('capacity');
    started=true;
    (deps.start??startPG)(stateDir,run);
    const s=JSON.parse(readFileSync(join(stateDir,'state.json'),'utf8'));
    if(s.db!=='lcm_restore_test_db' || s.socketDir!==join(stateDir,'s') || s.osUsername!==userInfo().username || !Number.isInteger(s.port)) throw Error('state');
    run(join(s.pgBinDir,'pg_restore'),[...pgArgs(s),'-d',s.db,'--exit-on-error','--no-owner','--no-privileges',join(backupDir,m.dump)]);
    let before=fingerprint(s,run);
    // A partial earlier run may already contain stored choices. In that case
    // the field is pre-existing too and MUST participate in the full proof.
    if(before.theme)before=fingerprint(s,run,false);
    if(before.tables!==+m.tables || before.history!==+m.mig_rows || before.applied!==+m.applied) throw Error('restore-count');
    const sql=readFileSync(join(root,MIGRATION.dir,'migration.sql'));
    if(hash(sql)!==MIGRATION.sqlSha256) throw Error('sql-pin');
    const applied=JSON.parse(run(join(s.pgBinDir,'psql'),[...pgArgs(s),'-d',s.db,'-XAt','-v','ON_ERROR_STOP=1','-c',`SELECT coalesce(json_agg(migration_name),'[]') FROM lcm._prisma_migrations WHERE finished_at IS NOT NULL`]));
    const pending=readdirSync(join(root,'prisma/migrations'),{withFileTypes:true}).filter(e=>e.isDirectory()&&!applied.includes(e.name)).map(e=>e.name);
    if(before.theme?pending.length!==0:pending.length!==1||pending[0]!==MIGRATION.name) throw Error('pending-inventory');
    const url=`postgresql://${encodeURIComponent(s.osUsername)}@localhost:${s.port}/${s.db}?host=${encodeURIComponent(s.socketDir)}&schema=lcm`;
    // Only local installed executable; never npx or a network installer.
    run(tools.cli,['migrate','deploy','--schema=./prisma/schema.prisma'],{cwd:root,env:{...process.env,DATABASE_URL:url,PRISMA_SCHEMA_ENGINE_BINARY:tools.engine,PRISMA_ENGINES_MIRROR:'http://127.0.0.1:9'}});
    const after=fingerprint(s,run,!before.theme),delta=before.theme?0:1;
    if(!after.theme || after.tables!==before.tables || after.history!==before.history+delta || after.applied!==before.applied+delta || after.proof!==before.proof) throw Error('migration-invariants');
    const q=sql=>run(join(s.pgBinDir,'psql'),[...pgArgs(s),'-d',s.db,'-XAt','-v','ON_ERROR_STOP=1','-c',sql]);
    if(q(`SELECT count(*)=1 FROM information_schema.columns WHERE table_schema='lcm' AND table_name='User' AND column_name='uiTheme' AND data_type='text' AND is_nullable='NO' AND column_default='''jade''::text'`)!=='t')throw Error('theme-column');
    if(q(`SELECT count(*)=1 FROM pg_constraint WHERE conrelid='lcm."User"'::regclass AND conname='User_uiTheme_check' AND contype='c' AND convalidated AND pg_get_constraintdef(oid)='CHECK (("uiTheme" = ANY (ARRAY[''jade''::text, ''aqua''::text, ''violet''::text, ''raspberry''::text, ''tangerine''::text])))'`)!=='t')throw Error('theme-check');
    if(!before.theme && q(`SELECT count(*)=0 FROM lcm."User" WHERE "uiTheme" IS DISTINCT FROM 'jade'`)!=='t')throw Error('theme-default-backfill');
    proof={verified:'true',source:sha,run:runId,attempt,dumpSha:m.sha256,sqlSha:MIGRATION.sqlSha256,helperSha:hash(readFileSync(new URL('./deploy-host.sh',import.meta.url))),proof:after.proof,image:m.image,dbIdentity:m.dbIdentity,expires:m.expires};
  } catch { failure=Error('local-restore-failed'); }
  finally {
    try { if(started)(deps.stop??stopPG)(stateDir,run); } catch { failure=Error('local-cleanup-failed'); }
    io.close();
  }
  if(failure) throw failure;
  return proof;
}
