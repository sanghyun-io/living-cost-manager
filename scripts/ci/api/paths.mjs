// needs-API detection for the LCM CI pipeline.
//
// Reads the JSON body of `gh api repos/<repo>/compare/<base>...<head>` (from
// the fixed live API health source and exact event head — never event.before
// reference) and classifies whether the API image must be rebuilt/promoted.
//
// Fail-closed rules (missing evidence ⇒ needs_api=true, never a silent skip):
//   - base is all zeros / missing (first push, force-push, history rewrite)
//   - compare JSON unreadable, missing `files`, or GitHub-reported truncation
//     (compare truncates the file list at 300 entries — a truncated list can
//     hide API paths, so treat exactly: if any API path is already present we
//     are true regardless; if truncated we cannot prove absence ⇒ true)
//   - compare base/head do not equal the pinned event SHAs
import { readFileSync } from "node:fs";
import {
  API_IMPACTING_PREFIXES,
  API_IMPACTING_FILES,
  SHA_RE,
  PROD,
} from "./constants.mjs";
// Deployment/diagnostic/restore support does not change the running API payload.
// These concrete producer/recipe files do. Unknown API business paths remain true.
const IMAGE_PIPELINE_FILES=new Set(['scripts/ci/api/image.mjs','scripts/ci/api/build-profile.mjs','scripts/ci/api/buildx-client.mjs','scripts/ci/api/resource-budget.mjs','scripts/ci/api/runtime-overlay.mjs','scripts/ci/api/runtime-overlay.cjs','scripts/ci/api/Dockerfile.runtime-overlay','scripts/ci/api/constants.mjs']);
export function liveApiBase(health) {
  if(!health||Array.isArray(health)||health.ok!==true||typeof health.commitSha!=='string'||!SHA_RE.test(health.commitSha)||/^0+$/.test(health.commitSha))throw Error('live-api-baseline-invalid');
  return health.commitSha;
}
export function classifyLiveCompare(compare,{health,head}={}) {
  let base;try{base=liveApiBase(health);}catch{return {needsApi:true,reason:'live-api-baseline-invalid'};}
  if(compare?.merge_base_commit?.sha!==base)return {needsApi:true,reason:'live-api-ancestor-unproven'};
  // REST status/merge-base and bounded chronological commits below must prove
  // this live source is an ancestor of the exact event head. No event.before assumption.
  return classifyCompare(compare,{base,head});
}

export function classifyCompare(compare, { base, head } = {}) {
  if (!SHA_RE.test(String(base)) || !SHA_RE.test(String(head)) ||
      /^0+$/.test(String(base)) || /^0+$/.test(String(head))) {
    return { needsApi: true, reason: "no-base" };
  }
  if (!compare || typeof compare !== "object" || Array.isArray(compare)) {
    return { needsApi: true, reason: "compare-unreadable" };
  }
  if (compare.base_commit?.sha !== base) {
    return { needsApi: true, reason: "compare-identity-mismatch" };
  }
  if (!Array.isArray(compare.files)) {
    return { needsApi: true, reason: "compare-files-missing" };
  }
  // GitHub compare has NO compare_from_sha/compare_to_sha or total_count.
  // Without pagination, commits are capped at 250 and files at 300. At either
  // boundary we cannot prove completeness, even if every visible path is web.
  if (compare.files.length >= 300) return { needsApi: true, reason: "compare-truncated" };
  const { commits, total_commits: total, status } = compare;
  if (!Array.isArray(commits) || !Number.isSafeInteger(total) || total < 0 ||
      total >= 250 || commits.length !== total) {
    return { needsApi: true, reason: "compare-commits-incomplete" };
  }
  if (commits.some(c => !SHA_RE.test(c?.sha ?? '') || /^0+$/.test(c.sha) || c.sha === base) ||
      new Set(commits.map(c => c.sha)).size !== commits.length) {
    return { needsApi: true, reason: "compare-identity-mismatch" };
  }
  if ((compare.behind_by !== undefined && compare.behind_by !== 0) ||
      (compare.ahead_by !== undefined && compare.ahead_by !== total) ||
      (compare.merge_base_commit !== undefined && compare.merge_base_commit?.sha !== base)) {
    return { needsApi: true, reason: "compare-status-inconsistent" };
  }
  if (status === 'identical' && base === head && total === 0 && compare.files.length === 0) {
    return { needsApi: false, reason: "web-only" };
  }
  // For an ahead comparison, a complete chronological commit list ending in
  // the exact immutable event head positively binds the requested destination.
  if (status !== 'ahead' || base === head || total === 0 || commits.at(-1)?.sha !== head) {
    return { needsApi: true, reason: "compare-identity-mismatch" };
  }
  const validPath = p => typeof p === 'string' && p.length > 0 &&
    !/[\x00-\x1f\x7f\\]/.test(p) && !p.split('/').some(s => s === '' || s === '.' || s === '..');
  const apiPath = p => API_IMPACTING_PREFIXES.some(pref => p.startsWith(pref)) ||
    API_IMPACTING_FILES.includes(p) || IMAGE_PIPELINE_FILES.has(p);
  const statuses = new Set(['added','removed','modified','renamed','copied','changed','unchanged']);
  for (const f of compare.files) {
    if (!f || !validPath(f.filename) || !statuses.has(f.status) ||
        (f.previous_filename !== undefined && !validPath(f.previous_filename)) ||
        (['renamed','copied'].includes(f.status) && f.previous_filename === undefined)) {
      return { needsApi: true, reason: "compare-file-malformed" };
    }
    for (const p of [f.filename, f.previous_filename].filter(p => p !== undefined)) {
      if (apiPath(p)) return { needsApi: true, reason: "api-path", path: p };
    }
  }
  return { needsApi: false, reason: "web-only" };
}

// CLI: node scripts/ci/api/paths.mjs detect --compare <file> --base <sha>
//      --head <sha> [--output <github-output-file>]
// Prints one line "needs_api=true|false reason=<reason>" and appends the
// outputs when --output is given. NEVER exits non-zero: every unexpected
// condition (missing/unreadable/malformed evidence) is reported as the
// fail-closed answer needs_api=true, so a detection hiccup cannot silently
// skip an API stage and cannot hard-block the pipeline either.
if (process.argv[2] === 'fetch-live') {
  try {
    const r=await fetch(PROD.publicHealthUrl,{signal:AbortSignal.timeout(10000),redirect:'error'});if(!r.ok||!r.body)throw Error('live-health-http');
    let n=0,parts=[];for await(const chunk of r.body){n+=chunk.length;if(n>32768)throw Error('live-health-size');parts.push(chunk);}
    const h=JSON.parse(Buffer.concat(parts).toString('utf8'));liveApiBase(h);
    const {writeFileSync}=await import('node:fs');writeFileSync(process.argv[3],JSON.stringify({ok:true,commitSha:h.commitSha}),{mode:0o600,flag:'wx'});
  }catch{console.error('live-api: unavailable-or-invalid');process.exitCode=1;}
} else if(process.argv[2]==='live-base') {
  try{console.log(liveApiBase(JSON.parse(readFileSync(process.argv[3],'utf8'))));}catch{console.error('live-api: unavailable-or-invalid');process.exitCode=1;}
} else if (process.argv[2] === "detect" || process.argv[2] === 'detect-live') {
  const { appendFileSync } = await import("node:fs");
  const args = process.argv.slice(3);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
  const emit = (needsApi, reason) => {
    const out = flag("output");
    if (out) appendFileSync(out, `needs_api=${needsApi ? "true" : "false"}\nreason=${reason}\n`);
    console.log(`needs_api=${needsApi ? "true" : "false"}`, `reason=${reason}`);
  };
  try {
    const compare = JSON.parse(readFileSync(flag("compare"), "utf8"));
    const result = process.argv[2]==='detect-live'?classifyLiveCompare(compare,{health:JSON.parse(readFileSync(flag('health'),'utf8')),head:flag('head')}):classifyCompare(compare, { base: flag("base"), head: flag("head") });
    emit(result.needsApi, result.reason);
  } catch {
    emit(true, "compare-unreadable");
  }
  process.exit(0);
}
