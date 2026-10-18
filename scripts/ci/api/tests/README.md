# scripts/ci/api — LCM API pipeline tests

Behavioural tests for the Actions→Mac Mini→OCI API build/backup/migrate/
deploy pipeline. They run the REAL bash/Node logic under a temp fixture tree
with PATH shims — no Docker engine, no network, no SSH, no production paths,
no root. (The real engine build + synthetic health test is executed
out-of-band before approval; see docs/api-deploy-actions-20261019.md.)

## Layout

- `../deploy-host.sh` — the OCI host helper (named ops, pinned constants).
  Tests execute it directly with:
  - `LCM_ROOT=<fixture>/opt/livingcost` (defaults to the production path in
    real runs — CI never sets LCM_ROOT)
  - `LCM_HELPER_ALLOW_NONROOT_TEST=1` + `LCM_ROOT` together are the ONLY
    bypass of the root gate; the workflow grep-asserts neither env appears in
    `.github/workflows/ci.yml`.
- `../deploy.mjs` — runner-side orchestrator; invoked with
  `LCM_SSH_BIN/LCM_CURL_BIN/OPS_KV_BIN` pointing at fakes.
- `../image.mjs` — capacity/archive guards exercised with a faked `df`.

## Fixture state (`$FAKE_HOST/state`)

Plain-text files consumed by the fakes:

| file | meaning |
| --- | --- |
| `applied.txt` | `_prisma_migrations` finished rows (names only) |
| `aborted.txt` | unfinished/aborted rows |
| `tables.txt` / `migrows.txt` | live schema counts |
| `restore_tables.txt` / `restore_migrows.txt` | counts seen by the rehearsal restore |
| `planning_present.txt` | `to_regclass('lcm."WorkspacePlanningState"') IS NOT NULL` |
| `cols_hash.txt` / `cons_hash.txt` | structural fingerprint replies |
| `container_running.txt` / `container_image.txt` | backend container identity |
| `health_local.txt` | commitSha the container-local health probe answers |
| `health_public.txt` | gateway `/v1/health` body for fake curl |
| `dump_bytes/rollback_bytes/archive_bytes/image_size` | size knobs |
| `image_sql_sha.txt` | planning migration.sql hash INSIDE the candidate image |
| `migration_dirs.txt` | migration inventory of the candidate image |
| `images.tsv` | `tag \t imageID \t revision-label` |
| `load_tag.txt` | tag `docker load` reports |
| `df_avail_k.txt` | fake `df` Available (KiB) |
| `opskv_version.txt` / `opskv_show.txt` / `opskv_stored.txt` | opskv fake CAS state |
| `calls.log` | every docker/ssh/curl/opskv argv (the leak + no-blind-retry assertions read this) |
| `createdb.log` / `droppedb.log` | rehearsal temp-database lifecycle |
| zero-byte flags `dump_fail restore_fail migrate_fail load_fail save_fail compose_up_fail fail_createdb hashes_bad curl_fail restore_fail` | failure injection |

Secret hygiene is asserted with two sentinels: `SENTINEL_DBPASS_4f2a`
(only allowed inside the fixture `api/.env`) and `SENTINEL_PGDUMP_ROW_8866`
(only allowed inside the `.dump` file).

Run: `pnpm exec vitest run --root ../../scripts/ci/api` from `apps/web`
(the CI `build-test` step).
