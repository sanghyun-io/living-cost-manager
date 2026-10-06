// Rehearses a complete synthetic-schema backup/restore on the already-owned
// test cluster. This is NOT a production backup or migration authorization.
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { TEMPLATE_SCENARIOS } from '../packages/shared/dist/index.js';
import { assertVerificationTarget } from './verification-target.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
const run=promisify(execFile);
const source=await assertVerificationTarget(process.env), uri=new URL(source);
const database='lcm_restore_'+crypto.randomUUID().replaceAll('-','');
assert.ok(/^lcm_restore_[a-f0-9]+$/.test(database));
const root=process.env.LCM_TEST_TEMP_ROOT;
if(!root) throw Error('LCM_TEST_TEMP_ROOT required');
const folder=await mkdtemp(path.join(root,'lcm-template-restore-')); await chmod(folder,0o700);
const pg=name=>process.env.PG_BIN?path.join(process.env.PG_BIN,name):name;
const connection=['-h','127.0.0.1','-p',uri.port,'-U',decodeURIComponent(uri.username)];
const prisma=new PrismaClient({datasourceUrl:source});
const restoreUrl=new URL(source);restoreUrl.pathname='/'+database;
const restored=new PrismaClient({datasourceUrl:restoreUrl.toString()});
let fixture,created=false;
try {
  fixture=await prisma.user.create({data:{email:`template-restore-${crypto.randomUUID()}@example.test`,name:'Synthetic restore fixture',passwordHash:'not-a-password'}});
  const template=await prisma.budgetTemplate.create({data:{userId:fixture.id,blueprint:TEMPLATE_SCENARIOS[0]}});
  await prisma.budgetTemplateShare.create({data:{templateId:template.id,token:'r'.repeat(43),blueprint:TEMPLATE_SCENARIOS[0],expiresAt:new Date(Date.now()+86400000)}});
  const dump=path.join(folder,'synthetic.dump');
  await run(pg('pg_dump'),[...connection,'-d','lcm_test','--schema=lcm_test','-Fc','-f',dump]);await chmod(dump,0o600);
  await run(pg('createdb'),[...connection,database]);created=true;
  await run(pg('pg_restore'),[...connection,'-d',database,'--exit-on-error','--no-owner',dump]);
  const author=await restored.user.findUnique({where:{id:fixture.id},select:{id:true,email:true,name:true,tokenVersion:true}});
  assert.equal(author.name,'Synthetic restore fixture'); // unchanged old-account fields remain readable
  const copy=await restored.budgetTemplate.findUnique({where:{id:template.id},include:{share:true}});
  assert.deepEqual(copy.blueprint,TEMPLATE_SCENARIOS[0]);assert.equal(copy.share.token,'r'.repeat(43));
  console.log('PASS template restore rehearsal: full synthetic schema/data pg_dump+pg_restore; existing account fields and new private/public blueprint tables intact');
} finally {
  if(fixture)await prisma.user.delete({where:{id:fixture.id}});
  await restored.$disconnect();await prisma.$disconnect();
  if(created)await run(pg('dropdb'),[...connection,database]);
  await rm(folder,{recursive:true,force:true});
  console.log('CLEANUP template restore: sibling isolated database and private synthetic dump removed');
}
