// Pinned constants for the LCM Actions→Mac Mini→OCI API pipeline.
//
// Everything here is reviewed, non-secret source of truth. The remote host
// helper (deploy-host.sh) carries the same values as its own embedded
// constants; api-deploy.mjs cross-checks that the installed helper's SHA
// matches this checkout before trusting any remote output (source pinning).
//
// PRODUCTION TRUTH (measured read-only on 2026-10-20; drift ⇒ the helper's
// CAS checks halt — see docs/api-deploy-actions-20261019.md). Remote registry
// re-pull of the current image is NOT established, so rollback depends on the
// host-side docker-save rollback archive (ensure-rollback op), never on a
// registry pull.
export const REPO = "sanghyun-io/living-cost-manager";
export const WORKFLOW_PATH = ".github/workflows/ci.yml";

// Exact protected-main identity (mirrors preflight job).
export const IDENTITY = Object.freeze({
  repository: REPO,
  ref: "refs/heads/main",
  event: "push",
});

// Production API image CAS + rollback target (pinned from read-only host
// evidence 2026-10-20; gamja-ops assets/services.yaml deployment block is the
// registry source of truth for the same values).
export const PROD = Object.freeze({
  host: "gamja-oci", // existing SSH config alias (ubuntu, pinned user-known-hosts file)
  composeProject: "livingcost",
  composeFile: "/opt/livingcost/docker-compose.yml",
  backendContainer: "livingcost-backend",
  apiPort: 4000,
  apiBasePath: "/living-cost-manager/v1",
  publicHealthUrl: "https://api.gamja.top/living-cost-manager/v1/health",
  currentReleaseSha: "02c70d1b9f463c000cfe8dc7132cab7b23d459ff",
  currentImageId:
    "sha256:5afa33fb3d3c42d54a58e0957f4098c922318060967d86b2f26e76454a7d48e0",
  currentComposeImageRef:
    "lcm-ci-api-02c70d1b9f463c000cfe8dc7132cab7b23d459ff:candidate",
  // Post-promotion the compose backend image string is replaced by this
  // exact pinned tag (docker-load preserves RepoTags; no registry exists to
  // digest-pin against, so every remote op re-verifies tag→imageID equality).
  newComposeImageTagPrefix: "lcm-ci-api-",
  dbContainer: "gamja-data-postgres",
  dbSuperuser: "gamja_admin", // metadata name from the existing backup script, not a secret
  dbName: "livingcost",
  dbSchema: "lcm",
  envFile: "/opt/livingcost/api/.env", // never read into argv/stdout; used via --env-file only
  backupsRoot: "/opt/livingcost/backups",
  rollbackDir: "/opt/livingcost/backups/rollback",
  reminderTimer: "livingcost-reminders.timer",
});

// The single approved additive migration (explicit Owner approval 2026-10-20
// covers ONLY this migration on this target). Any other pending item halts.
export const MIGRATION = Object.freeze({
  name: "20261020120000_add_user_ui_theme",
  dir: "prisma/migrations/20261020120000_add_user_ui_theme",
  sqlFile: "migration.sql",
  sqlSha256:
    "1ba3540c796a3e198803a6b9e3c49c60ae300adb5e329505cd25f5be9e06386b",
  expectedAppliedCount: 12, // rows with finished_at NOT NULL before promotion
  expectedHistoryRows: 13, // total _prisma_migrations rows before promotion
  expectedTablesBefore: 25, // column addition: no new table
  expectedTablesAfter: 25,
});

// Disk budget (measured 2026-10-19: Mac Mini 25 GiB free / floor 15 GiB;
// OCI / 9.1 GiB free). Values are the policy formula: peak*1.2 + recovery
// reserve; the floor is never lowered by this pipeline.
export const BUDGET = Object.freeze({
  // Physical host only. Task-specific additional estimates live in resource-budget.mjs.
  mac: Object.freeze({ floorGib: 15, reserveGib: 1 }),
  oci: Object.freeze({
    // own writes: rollback archive ~0.7 GiB (reuse-if-valid), dump ≪ 1 GiB,
    // rehearsal temp DB ≤ dump*2.5, loaded candidate ~0.7 GiB.
    floorGib: 4,
    maxDumpBytes: 1 * 1024 * 1024 * 1024,
    maxArchiveBytes: 3 * 1024 * 1024 * 1024,
  }),
});

// CI-local image/archive naming (never pushed to any registry).
export const IMAGE_NAME = (sha) => `lcm-ci-api-${sha}:candidate`;
export const ARCHIVE_ARTIFACT = (sha) => `lcm-api-image-${sha}`;

export const SHA_RE = /^[0-9a-f]{40}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

// Paths whose changes mean the API image must be rebuilt+promoted. Anything
// else (pure web/marketing/docs) must skip the API stages. Fail-closed rule:
// unknown/truncated/unavailable evidence ⇒ needs_api = true.
export const API_IMPACTING_PREFIXES = Object.freeze([
  "apps/api/",
  "packages/shared/",
  "prisma/",
  "apps/api/Dockerfile", // covered by prefix, listed for clarity
]);
export const API_IMPACTING_FILES = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/api/package.json",
  "apps/api/tsconfig.json",
  "packages/shared/package.json",
  "packages/shared/tsconfig.json",
  ".github/workflows/ci.yml",
]);
