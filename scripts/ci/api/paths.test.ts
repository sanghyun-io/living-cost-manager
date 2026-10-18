import {describe,it,expect,afterEach} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {classifyCompare} from './paths.mjs';
const base='a'.repeat(40),head='b'.repeat(40),ids={base,head};
// Synthetic values, actual REST response field names. No nonstandard head/from
// or total_count fields: completeness must come from the bounded REST lists.
const rest=(extra={})=>({base_commit:{sha:base},merge_base_commit:{sha:base},status:'ahead',ahead_by:1,behind_by:0,total_commits:1,commits:[{sha:head}],files:[{sha:'c'.repeat(40),filename:'apps/web/src/App.tsx',status:'modified',additions:1,deletions:1,changes:2}],...extra});
const roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
describe('actual compare REST shape',()=>{
 it('positively binds a complete web-only response without invented fields',()=>{
  expect(classifyCompare(rest(),ids)).toEqual({needsApi:false,reason:'web-only'});
 });
 it.each(['apps/api/src/app.ts','packages/shared/src/x.ts','prisma/schema.prisma','package.json','pnpm-lock.yaml','.github/workflows/ci.yml','scripts/ci/api/deploy-host.sh'])('API-impacting path %s',filename=>{
  expect(classifyCompare(rest({files:[{filename,status:'modified'}]}),ids).needsApi).toBe(true);
 });
 it.each([299,300,301])('bounds the REST file list at %i (no total_count available)',n=>{
  const c=rest({files:Array.from({length:n},(_,i)=>({filename:`apps/web/${i}.tsx`,status:'modified'}))});
  expect(classifyCompare(c,ids).needsApi).toBe(n>=300);
 });
 it.each([249,250,251])('bounds complete commit metadata at %i',n=>{
  const commits=Array.from({length:n},(_,i)=>({sha:(i+1).toString(16).padStart(40,'0')}));commits[n-1]={sha:head};
  expect(classifyCompare(rest({total_commits:n,ahead_by:n,commits}),ids).needsApi).toBe(n>=250);
 });
 it.each([
  {commits:undefined},{commits:[]},{commits:[{sha:'c'.repeat(40)}]},
  {commits:[{}]},{commits:[{sha:head},{sha:head}],total_commits:2,ahead_by:2},
  {base_commit:{sha:'c'.repeat(40)}},{base_commit:undefined},
  {merge_base_commit:{sha:'c'.repeat(40)}},
  {total_commits:undefined},{total_commits:2},{total_commits:NaN},{total_commits:'1'},
  {status:undefined},{status:'behind'},{status:'diverged'},{status:'identical'},
  {ahead_by:2},{behind_by:1},{files:undefined},{files:{}},
  {message:'Not Found',status:'404'},
 ])('ambiguous/inconsistent evidence fails closed: %j',extra=>{
  expect(classifyCompare(rest(extra),ids).needsApi).toBe(true);
 });
 it('exact identical comparison may skip only with identical base/head and empty lists',()=>{
  const c=rest({status:'identical',ahead_by:0,behind_by:0,total_commits:0,commits:[],files:[]});
  expect(classifyCompare(c,{base,head:base}).needsApi).toBe(false);
  expect(classifyCompare(c,ids).needsApi).toBe(true);
  expect(classifyCompare({...c,files:[{filename:'apps/web/a.tsx',status:'modified'}]},{base,head:base}).needsApi).toBe(true);
  expect(classifyCompare(rest(),{base,head:base}).needsApi).toBe(true);
 });
 it('rename from API to web and deletion retain API impact',()=>{
  expect(classifyCompare(rest({files:[{filename:'apps/web/moved.ts',previous_filename:'apps/api/old.ts',status:'renamed'}]}),ids).needsApi).toBe(true);
  expect(classifyCompare(rest({files:[{filename:'apps/api/old.ts',status:'removed'}]}),ids).needsApi).toBe(true);
  expect(classifyCompare(rest({files:[{filename:'apps/web/new.ts',previous_filename:'apps/web/old.ts',status:'renamed'}]}),ids).needsApi).toBe(false);
 });
 it.each([null,{}, {filename:''}, {filename:42}, {filename:'/apps/web/x'}, {filename:'apps/web/../api/x'}, {filename:'apps/web//x'}, {filename:'apps/web/\nx'}, {filename:'apps/web/x',status:'renamed'}, {filename:'apps/web/x',status:'modified',previous_filename:42}, {filename:'apps/web/x',status:'unknown'}])('malformed file evidence fails closed: %j',file=>{
  expect(classifyCompare(rest({files:[file]}),ids).needsApi).toBe(true);
 });
 it.each(['not json','{"message":"Not Found"}','null','[]'])('CLI safely fails closed on invalid/error response %s',body=>{
  const p=mkdtempSync(join(tmpdir(),'lcm-paths-'));roots.push(p);
  const input=join(p,'compare.json'),out=join(p,'output');writeFileSync(input,body);
  const r=spawnSync(process.execPath,[join(import.meta.dirname,'paths.mjs'),'detect','--base',base,'--head',head,'--compare',input,'--output',out],{encoding:'utf8'});
  expect(r.status).toBe(0);expect(readFileSync(out,'utf8')).toContain('needs_api=true');
  expect(r.stdout).not.toContain(body);
 });
 it.each([['apps/web/src/App.tsx',false],['apps/api/src/app.ts',true]])('CLI consumes unchanged REST JSON for %s', (filename,expected)=>{
  const p=mkdtempSync(join(tmpdir(),'lcm-paths-'));roots.push(p);
  const input=join(p,'compare.json'),out=join(p,'output');writeFileSync(input,JSON.stringify(rest({files:[{filename,status:'modified'}]})));
  const r=spawnSync(process.execPath,[join(import.meta.dirname,'paths.mjs'),'detect','--base',base,'--head',head,'--compare',input,'--output',out],{encoding:'utf8'});
  expect(r.status).toBe(0);expect(readFileSync(out,'utf8')).toContain(`needs_api=${expected}`);
 });
 it.each([{base:'0'.repeat(40),head},{base,head:'0'.repeat(40)},{base,head:'HEAD'},{base:'main',head}])('requires exact immutable event SHAs: %j',inputs=>{
  expect(classifyCompare(rest(),inputs).needsApi).toBe(true);
 });
});
