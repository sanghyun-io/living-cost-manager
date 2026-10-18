import {MIGRATION, REPO, WORKFLOW_PATH} from './constants.mjs';
export function validateMetadata(m, sha, env = process.env) {
  const exact = {schema:'lcm-api-archive-v1', repo:REPO, workflowPath:WORKFLOW_PATH,
    platform:'linux/arm64', sha, releaseShaLabel:sha, migrationName:MIGRATION.name,
    migrationSqlSha256:MIGRATION.sqlSha256, runId:env.GITHUB_RUN_ID,
    runAttempt:env.GITHUB_RUN_ATTEMPT};
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_SHA !== sha || !/^[a-f0-9]{40}$/.test(sha??'') || !/^[1-9][0-9]{0,14}$/.test(env.GITHUB_RUN_ID ?? '') ||
      !/^[1-9][0-9]{0,3}$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
      env.GITHUB_WORKFLOW_REF !== `${REPO}/${WORKFLOW_PATH}@refs/heads/main`)
    throw new Error('trusted workflow identity missing');
  for (const [k,v] of Object.entries(exact)) if (!v || m[k] !== v) throw new Error(`metadata binding: ${k}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(m.imageId ?? '') || !/^[a-f0-9]{64}$/.test(m.archiveSha256 ?? '') ||
      !Number.isSafeInteger(m.archiveBytes) || m.archiveBytes <= 0 || m.archiveBytes > 3*1024**3 ||
      !Number.isSafeInteger(m.imageBytes) || m.imageBytes <= 0 || m.imageBytes > 4*1024**3 ||
      m.archivePath !== 'image.tar.gz') throw new Error('metadata format');
}
