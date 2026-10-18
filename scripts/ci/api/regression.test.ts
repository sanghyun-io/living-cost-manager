import {it, expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MIGRATION} from './constants.mjs';
it('rejects metadata missing workflow/run/repo/platform before image access',()=>{
 const d=mkdtempSync(join(tmpdir(),'lcm-api-regression-'));
 try {
  writeFileSync(join(d,'a.gz'),'one');
  writeFileSync(join(d,'m.json'),JSON.stringify({sha:'b'.repeat(40),imageId:'sha256:'+'c'.repeat(64),archiveSha256:createHash('sha256').update('one').digest('hex'),archiveBytes:3,migrationSqlSha256:MIGRATION.sqlSha256}));
  const r=spawnSync('node',['scripts/ci/api/image.mjs','verify-archive','--sha','b'.repeat(40),'--archive',join(d,'a.gz'),'--metadata',join(d,'m.json')],{encoding:'utf8'});
  expect(r.status).not.toBe(0);
 } finally {rmSync(d,{recursive:true,force:true});}
});
