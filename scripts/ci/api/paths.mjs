// needs-API detection for the LCM CI pipeline.
//
// Reads the JSON body of `gh api repos/<repo>/compare/<base>...<head>` (from
// the push event payload SHAs — bounded and exact, never a mutable HEAD
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
} from "./constants.mjs";

export function classifyCompare(compare, { base, head }) {
  if (!SHA_RE.test(String(base)) || !SHA_RE.test(String(head)) ||
      /^0+$/.test(String(base))) {
    return { needsApi: true, reason: "no-base" };
  }
  if (!compare || typeof compare !== "object") {
    return { needsApi: true, reason: "compare-unreadable" };
  }
  if (compare.base_commit?.sha !== base || compare.compare_from_sha !== base ||
      compare.compare_to_sha !== head) {
    // The JSON must describe exactly base...head we asked for; anything else
    // is unbounded evidence.
    return { needsApi: true, reason: "compare-identity-mismatch" };
  }
  if (!Array.isArray(compare.files)) {
    return { needsApi: true, reason: "compare-files-missing" };
  }
  let matched = null;
  for (const f of compare.files) {
    const p = String(f?.filename ?? "");
    if (
      API_IMPACTING_PREFIXES.some((pref) => p.startsWith(pref)) ||
      API_IMPACTING_FILES.includes(p)
    ) {
      matched = p;
      break;
    }
  }
  if (matched) return { needsApi: true, reason: "api-path", path: matched };
  if (compare.total_count !== undefined && compare.total_count !== compare.files.length) {
    return { needsApi: true, reason: "compare-truncated" };
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
if (process.argv[2] === "detect") {
  const { appendFileSync } = await import("node:fs");
  const args = process.argv.slice(3);
  const flag = (n) => args[args.indexOf(`--${n}`) + 1];
  const emit = (needsApi, reason) => {
    const out = flag("output");
    if (out) appendFileSync(out, `needs_api=${needsApi ? "true" : "false"}\nreason=${reason}\n`);
    console.log(`needs_api=${needsApi ? "true" : "false"}`, `reason=${reason}`);
  };
  try {
    const compare = JSON.parse(readFileSync(flag("compare"), "utf8"));
    const result = classifyCompare(compare, { base: flag("base"), head: flag("head") });
    emit(result.needsApi, result.reason);
  } catch {
    emit(true, "compare-unreadable");
  }
  process.exit(0);
}
