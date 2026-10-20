import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {BASE} from './runtime-overlay.mjs';
import {PROD,MIGRATION} from './constants.mjs';
const req=createRequire(import.meta.url),{verifyThemeModel}=req('./runtime-overlay.cjs');
it('binds new SQL, unchanged table inventory and distinct dependency donor/current rollback identities',()=>{
 expect(BASE.imageId).not.toBe(PROD.currentImageId);expect(BASE.source).not.toBe(PROD.currentReleaseSha);
 expect(PROD.currentComposeImageRef).toBe(`lcm-ci-api-${PROD.currentReleaseSha}:candidate`);
 const sql=readFileSync(new URL('../../../'+MIGRATION.dir+'/migration.sql',import.meta.url));expect(createHash('sha256').update(sql).digest('hex')).toBe(MIGRATION.sqlSha256);
 expect(MIGRATION.expectedTablesBefore).toBe(MIGRATION.expectedTablesAfter);expect(MIGRATION.expectedAppliedCount).toBe(12);expect(MIGRATION.expectedHistoryRows).toBe(13);
 const host=readFileSync(new URL('./deploy-host.sh',import.meta.url),'utf8');expect(host).toContain('OLD_IMAGE_ID='+PROD.currentImageId);expect(host).toContain('BASE_IMAGE_ID='+BASE.imageId);expect(host).toContain('PENDING_SQL_SHA='+MIGRATION.sqlSha256);
 const base=host.split('  base-archive-manifest)')[1].split('  base-archive-stream)')[0];expect(base).toContain('${BASE_IMAGE_ID:7:12}');expect(base).not.toContain('ensure-rollback');
});
it.each(['missing','optional','wrong-type','wrong-default','valid'])('generated client User.uiTheme check: %s',mode=>{
 const field={name:'uiTheme',type:mode==='wrong-type'?'Int':'String',isRequired:mode!=='optional',default:mode==='wrong-default'?'aqua':'jade'};
 const P={dmmf:{datamodel:{models:[{name:'User',fields:mode==='missing'?[]:[field]}]}}};
 if(mode==='valid')expect(()=>verifyThemeModel(P)).not.toThrow();else expect(()=>verifyThemeModel(P)).toThrow('theme-client-not-regenerated');
});
