# User.uiTheme release readiness — 2026-10-20

Status: **LOCAL SOURCE ONLY; NOT DEPLOYED / NOT MIGRATED**. The Owner approved
only the one additive field, conditional on fresh backup, isolated restore and
independent review. Publishing/executing Actions remains the main session's gate.

## Fresh read-only baseline

Routine `ssh -G gamja-oci` selected Tailscale `100.74.150.0`; actual hostname
`gamjaworld-prod-main-vnic`. Selected container metadata and internal health agree:

- source `02c70d1b9f463c000cfe8dc7132cab7b23d459ff`
- Config.Image `lcm-ci-api-02c70d1b9f463c000cfe8dc7132cab7b23d459ff:candidate`
- Docker image ID `sha256:5afa33fb3d3c42d54a58e0957f4098c922318060967d86b2f26e76454a7d48e0`
- `livingcost.lcm`: 25 tables, 12 finished migrations / 13 history rows,
  planning table present, User.uiTheme absent. Migration names/checksums and
  rolled-back marker were checked without customer-row output. The baseline
  history digest in the helper covers names/checksums/status, not customer data.
- `opskv` list/show/history: BACKEND_IMAGE active version 3; a new protected
  `get --output` file compared equal to observed Config.Image and was removed.
  No value write or independent .env change.

## Separate donor from rollback

The dependency donor remains a2c7bd9 / Docker image 5d133132b544, Node 24.19.0,
ABI 137, Prisma 6.19.3. Its retained root-0600 archive is 150,467,839 bytes;
metadata's size, image/source and SHA256 match. It is **not** the rollback image
for this new release. Base export fails closed if this protected input is missing
or mismatched; it no longer calls ensure-rollback to recreate a donor.

The future run must separately retain the currently serving **02c70d1b / 5afa33fb**
archive with matching metadata before promotion. Never overwrite invalid retained
evidence; never pull an unproven registry reference. Root-private exclusive staging,
compressed-byte cap, hash/size/source binding and physical/guest capacity guards
remain. No VM/context changes, prune, helper installation or image build occurred
in this source-only work.

## Future gated Actions sequence

1. Exact reviewed main SHA + same run/attempt compiled overlay, strict dependency
   graph compatibility against immutable donor, regenerated Linux Prisma client.
2. Internal synthetic PostgreSQL only: all 13 image migrations, exact new SQL
   hash, old planning roundtrip, User.uiTheme client/default, authenticated login,
   strict PUT body/unauthenticated rejection and PUT→GET all five theme choices.
   No production user creation or provider/model calls.
3. Serving-source and opskv reference CAS. Preserve current backend image archive.
   Seal existing root-private env and verify actual Prisma database/schema/server
   address/port against PostgreSQL metadata before dump and migration.
4. Fresh pg_dump + protected offhost copy; native isolated PG16 peer/socket restore
   (no TCP, no application, never restore into production). Apply only
   `20261020120000_add_user_ui_theme`, SQL SHA256
   `1ba3540c796a3e198803a6b9e3c49c60ae300adb5e329505cd25f5be9e06386b`.
   SQL retains lock_timeout 5s / statement_timeout 30s and one transaction.
5. Restore proof compares **all existing tables and all old columns** (including
   User, financial rows and planning rows), ignoring only User.uiTheme and its
   named new constraint. Verify TEXT / NOT NULL / default jade / validated exact
   five-value CHECK and existing-user aggregate jade backfill. Table count stays
   25; history/applied each increase by one. No raw rows or row fingerprints in
   repository, Actions logs or artifacts.
6. Receipt binds source/run/attempt, SQL/helper/dump hashes, candidate image,
   actual DB identity and one-hour expiry; only issued after successful restore,
   invariants and cleanup. Promote backend image only, verify health/source and
   catalog, then update official image reference with existing opskv CAS path.

Rollback restores the 02c70d1b backend image only. **Retain User.uiTheme and all
stored choices, constraints, history, financial/planning data and backups. Never
DROP the field.** Do not require the already-used planning table to be empty.
No billing/checkout/consent flags, Cloudflare secrets or provider changes.

## Ownership / validation

Frontend and business API/schema source belong to parallel owners; this change
does not edit them. CI fixture tests and isolated synthetic PG16 restore are local
evidence only, not a new image smoke/deployment or independent review. Main must
obtain separate reviewer acceptance before publishing/executing this pipeline.
Ops registry companion: `gamja-ops` branch `docs/lcm-jade-theme-20261020`, planned
records only; no remote publication in this task.

Local verification: API pipeline 312/312 tests passed (12 files), including
actual synthetic PG16 custom dump/isolated restore/apply/default/CHECK/history
proof and negative mutation checks for old User, financial and planning columns.
Runner kit: 46 passed, 2 cache-dependent skips (no download). Bash syntax and
diff whitespace checks passed. Registry assets verified; local drift check exits
1 with 44 errors, byte-identical to the untouched prior registry worktree's
output (unrelated existing missing paths/agents), not repaired in this scope.

Resource receipt: small-text/fixture budget only (<200 MiB peak); no image build,
VM, model, download or protected production dump generated. Synthetic clusters
and registered test temp roots were stopped/removed by test cleanup, and the
one protected opskv comparison file/directory was removed. Physical `df -h .`
before/after both reported 36 GiB available; concurrent-session variation is not
attributed to this task. The new ops worktree is retained solely for main's
review/publication of these source records; no new large artifact retained.
