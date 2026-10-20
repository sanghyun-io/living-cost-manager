// Fixed-command Linux helper; never starts the application or reads a customer DB.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{createRequire}=require('module'),{spawnSync}=require('child_process');
const BASE='sha256:5d133132b544a0d5b07d471dab7e4a8a1dfb51d491be12ab7c7bb36c14ce667f';
const SOURCE='a2c7bd9af46d84dc88b2a36656c25949b57076b0';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=x=>JSON.stringify(x&&typeof x==='object'?Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])):x);
const core=p=>Object.fromEntries(['name','version','type','main','types','exports'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));
function inside(p,root){return p.startsWith(root+'/')&&p!==root;}
function sharedRoot(app='/app',real=fs.realpathSync){const p=real(path.join(app,'node_modules/@living-cost-manager/shared'));if(!inside(p,path.join(app,'node_modules'))||path.normalize(p)!==p)throw Error('shared-path-escape');return p;}
function tree(root){const rows=[];function walk(dir,prefix=''){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=prefix?prefix+'/'+e.name:e.name,f=path.join(dir,e.name),s=fs.lstatSync(f);if(s.isSymbolicLink())throw Error('code-symlink');if(s.isDirectory())walk(f,p);else if(s.isFile())rows.push({path:p,bytes:s.size,sha256:sha(fs.readFileSync(f))});else throw Error('code-type');}}walk(root);return rows.sort((a,b)=>a.path.localeCompare(b.path));}
function stats(root){let bytes=0,files=0;function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name),s=fs.lstatSync(f);if(s.isDirectory())walk(f);else if(s.isFile()){if(/^\.env(?:\.|$)/.test(e.name)||/\.(dump|sqlite|db)$/.test(e.name))throw Error('unsafe-image-file');bytes+=s.size;files++;}}}walk(root);return {bytes,files};}
function audit(){
 if(process.platform!=='linux'||process.arch!=='arm64'||+process.versions.node.split('.')[0]!==24||process.versions.modules!=='137')throw Error('runtime-abi');
 const top=fs.readdirSync('/app');if(top.some(n=>!['dist','node_modules','package.json','prisma'].includes(n)))throw Error('unclassified-app-data');
 const req=createRequire('/app/package.json'),prisma=JSON.parse(fs.readFileSync(req.resolve('prisma/package.json'))).version;if(prisma!=='6.19.3')throw Error('prisma-version');
 const client=req.resolve('@prisma/client'),generated=path.dirname(createRequire(client).resolve('.prisma/client/package.json')),s=stats(generated);stats('/app');
 req('argon2'); // Linux native ABI load, no hash/login/customer operation
 const shared=sharedRoot();return {node:process.version,nodeMajor:24,abi:process.versions.modules,platform:'linux/arm64',prisma,sharedPath:shared,generatedBytes:s.bytes,generatedFiles:s.files,safety:true,apiCore:core(JSON.parse(fs.readFileSync('/app/package.json'))),sharedCore:core(JSON.parse(fs.readFileSync(path.join(shared,'package.json'))))};
}
function loadInput(){
 const root='/opt/lcm-overlay-input',m=JSON.parse(fs.readFileSync(root+'/bundle.json')),digest=m.bundleSha256;delete m.bundleSha256;
 if(sha(canonical(m))!==digest||digest!==process.env.LCM_BUNDLE_SHA||m.source!==process.env.RELEASE_SHA||m.dependencyProof.sha256!==process.env.LCM_DEPENDENCY_PROOF_SHA||m.dependencyProof.baselineImageId!==BASE||m.dependencyProof.baselineSource!==SOURCE||process.env.LCM_BASE_IMAGE_ID!==BASE)throw Error('overlay-binding');
 for(const f of m.files){if(typeof f.path!=='string'||f.path.startsWith('/')||f.path.split('/').some(x=>!x||x==='..'||x==='.')||/[\x00-\x1f\\]/.test(f.path))throw Error('payload-path');const p=path.join(root,f.path),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size!==f.bytes||sha(fs.readFileSync(p))!==f.sha256)throw Error('payload-integrity');}
 return {root,m:{...m,bundleSha256:digest}};
}
function verifyCode(m,app='/app'){
 const shared=sharedRoot(app);if(fs.readdirSync(app).some(n=>!['dist','node_modules','package.json','prisma'].includes(n))||fs.readdirSync(shared).some(n=>!['dist','package.json','node_modules','LICENSE','LICENSE.md','LICENSE.txt','README.md'].includes(n)))throw Error('obsolete-runtime-code');
 for(const [prefix,dest]of [['api/dist/',path.join(app,'dist')],['shared/dist/',path.join(shared,'dist')],['prisma/',path.join(app,'prisma')]]){const expected=m.files.filter(f=>f.path.startsWith(prefix)).map(f=>({...f,path:f.path.slice(prefix.length)})).sort((a,b)=>a.path.localeCompare(b.path));if(canonical(tree(dest))!==canonical(expected))throw Error('installed-code-digest');}
 if(canonical(core(JSON.parse(fs.readFileSync(path.join(app,'package.json')))))!==canonical(m.dependencyProof.apiCore)||canonical(core(JSON.parse(fs.readFileSync(path.join(shared,'package.json')))))!==canonical(m.dependencyProof.sharedCore))throw Error('package-exports');
 const req=createRequire(path.join(app,'package.json')),P=req('@prisma/client').Prisma;if(!P.dmmf.datamodel.models.some(x=>x.name==='WorkspacePlanningState'))throw Error('planning-client-not-regenerated');verifyThemeModel(P);
 const generated=path.dirname(createRequire(req.resolve('@prisma/client')).resolve('.prisma/client/package.json'));const s=stats(generated),baseline=JSON.parse(fs.readFileSync('/opt/lcm-baseline.json'));if(s.bytes>baseline.audit.generatedBytes*2+m.bytes*2)throw Error('generated-client-cap');return {generatedBytes:s.bytes};
}
function apply(){const {root,m}=loadInput(),base=JSON.parse(fs.readFileSync('/opt/lcm-baseline.json')),a=audit();if(base.imageId!==BASE||base.source!==SOURCE||canonical(a.apiCore)!==canonical(m.dependencyProof.apiCore)||canonical(a.sharedCore)!==canonical(m.dependencyProof.sharedCore)||canonical(a.apiCore)!==canonical(base.audit.apiCore)||canonical(a.sharedCore)!==canonical(base.audit.sharedCore))throw Error('baseline-package-core');
 const req=createRequire('/app/package.json'),generated=path.dirname(createRequire(req.resolve('@prisma/client')).resolve('.prisma/client/package.json'));if(!inside(fs.realpathSync(generated),'/app/node_modules'))throw Error('generated-path-escape');
 const engines=fs.readdirSync(generated).filter(n=>/linux.*arm64.*\.so\.node$/.test(n));if(engines.length!==1)throw Error('baseline-linux-engine');
 fs.mkdirSync('/opt/lcm-prisma-engine',{mode:0o700});fs.copyFileSync(path.join(generated,engines[0]),path.join('/opt/lcm-prisma-engine',engines[0]));
 fs.rmSync(generated,{recursive:true}); // NO old generated JS/client survives; only native Linux library is reused
 const shared=sharedRoot();for(const p of ['/app/dist','/app/prisma'])fs.rmSync(p,{recursive:true,force:true});
 for(const n of fs.readdirSync(shared))if(!['node_modules','LICENSE','LICENSE.md','LICENSE.txt','README.md'].includes(n))fs.rmSync(path.join(shared,n),{recursive:true,force:true});
 for(const [src,dest]of [['api/dist','/app/dist'],['prisma','/app/prisma'],['shared/dist',path.join(shared,'dist')],['api/package.json','/app/package.json'],['shared/package.json',path.join(shared,'package.json')]])fs.cpSync(path.join(root,src),dest,{recursive:true,dereference:false});
}
function generate(){const e=fs.readdirSync('/opt/lcm-prisma-engine');if(e.length!==1)throw Error('linux-engine-snapshot');const r=spawnSync('/app/node_modules/.bin/prisma',['generate','--schema=/app/prisma/schema.prisma'],{env:{...process.env,PRISMA_QUERY_ENGINE_LIBRARY:path.join('/opt/lcm-prisma-engine',e[0]),PRISMA_ENGINES_MIRROR:'http://127.0.0.1:9'},stdio:'inherit'});if(r.status!==0)throw Error('linux-generate');}
function finalize(){const {root,m}=loadInput();const result=verifyCode(m);fs.copyFileSync(__filename,'/opt/lcm-overlay-verify.cjs');fs.writeFileSync('/opt/lcm-overlay-proof.json',JSON.stringify({manifest:m,helperSha256:sha(fs.readFileSync(__filename)),...result}));fs.rmSync(root,{recursive:true});fs.rmSync('/opt/lcm-prisma-engine',{recursive:true});}
async function smoke(){const u=new URL(process.env.DATABASE_URL??'');if(u.username!=='lcm_synth'||u.pathname!=='/lcm_synth'||!u.hostname.startsWith('lcm-ci-pg-')||u.searchParams.get('schema')!=='lcm')throw Error('synthetic-target');const {PrismaClient}=createRequire('/app/package.json')('@prisma/client'),p=new PrismaClient(),id='overlay-synthetic-'+crypto.randomBytes(8).toString('hex');try{await p.workspace.create({data:{id,name:'synthetic'}});await p.workspacePlanningState.create({data:{workspaceId:id,payloadJson:{kind:'synthetic'},revision:1}});await p.workspacePlanningState.update({where:{workspaceId:id},data:{revision:2,payloadJson:{kind:'updated'}}});const x=await p.workspacePlanningState.findUnique({where:{workspaceId:id}});if(x.revision!==2||x.payloadJson.kind!=='updated')throw Error('planning-roundtrip');await p.workspace.delete({where:{id}});}finally{await p.$disconnect();}}
function verifyThemeModel(P){const f=P.dmmf.datamodel.models.find(x=>x.name==='User')?.fields.find(x=>x.name==='uiTheme');if(!f||f.type!=='String'||!f.isRequired||f.default!=='jade')throw Error('theme-client-not-regenerated');}
async function apiSmoke(){
 const u=new URL(process.env.DATABASE_URL??'');if(u.username!=='lcm_synth'||u.pathname!=='/lcm_synth'||!u.hostname.startsWith('lcm-ci-pg-')||u.searchParams.get('schema')!=='lcm')throw Error('synthetic-target');
 const req=createRequire('/app/package.json'),{PrismaClient,Prisma}=req('@prisma/client');verifyThemeModel(Prisma);
 const p=new PrismaClient(),id='theme-synthetic-'+crypto.randomBytes(8).toString('hex'),email=id+'@example.invalid',password='Synthetic-only-7!';
 try{
  const user=await p.user.create({data:{id,email,name:'synthetic',passwordHash:await req('argon2').hash(password)}});if(user.uiTheme!=='jade')throw Error('theme-default');
  const call=(route,method='GET',body,token)=>fetch('http://127.0.0.1:4000/v1'+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const login=await call('/auth/login','POST',{email,password}),auth=await login.json();if(login.status!==200||!auth.accessToken||auth.user.uiTheme!=='jade')throw Error('synthetic-login');
  if((await call('/me/theme','PUT',{uiTheme:'aqua'})).status!==401)throw Error('theme-auth');
  for(const body of [{uiTheme:'unknown'},{uiTheme:'aqua',userId:'other'},{}])if((await call('/me/theme','PUT',body,auth.accessToken)).status!==400)throw Error('theme-strict');
  for(const uiTheme of ['jade','aqua','violet','raspberry','tangerine']){const r=await call('/me/theme','PUT',{uiTheme},auth.accessToken),b=await r.json();if(r.status!==200||JSON.stringify(b)!==JSON.stringify({uiTheme}))throw Error('theme-put');const me=await call('/me','GET',undefined,auth.accessToken);if(me.status!==200||(await me.json()).user.uiTheme!==uiTheme)throw Error('theme-get');}
  const after=await p.user.findUnique({where:{id}});if(after.tokenVersion!==user.tokenVersion||after.passwordHash!==user.passwordHash||after.name!==user.name)throw Error('theme-unrelated-state');
 }finally{await p.user.deleteMany({where:{id}});await p.$disconnect();}
}
module.exports={sharedRoot,tree,core,verifyCode,verifyThemeModel,apiSmoke};
if(require.main===module||process.argv[1]==='-')Promise.resolve().then(()=>{const mode=process.argv[2];if(mode==='audit')console.log(JSON.stringify(audit()));else if(mode==='apply')apply();else if(mode==='generate')generate();else if(mode==='finalize')finalize();else if(mode==='verify-installed'){const x=JSON.parse(fs.readFileSync('/opt/lcm-overlay-proof.json')),m={...x.manifest},digest=m.bundleSha256;delete m.bundleSha256;if(sha(canonical(m))!==digest||x.manifest.source!==process.env.RELEASE_SHA||sha(fs.readFileSync(__filename))!==x.helperSha256)throw Error('candidate-helper');verifyCode(x.manifest);}else if(mode==='smoke')return smoke();else throw Error('fixed-mode');}).catch(()=>{console.error('overlay-linux: gate-failed');process.exitCode=1;});
