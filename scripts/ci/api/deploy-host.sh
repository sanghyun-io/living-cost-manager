#!/usr/bin/env bash
# LCM Actions→Mac Mini→OCI API deploy host helper.
#
# Design rules (reviewed — docs/api-deploy-actions-20261019.md):
#   * ONLY named operations in a fixed allowlist; every constant is embedded
#     here (CI pins this file's SHA256 — source pinning). All CLI arguments
#     are regex-validated; nothing executable comes from caller input.
#   * Runs as root — this automates the operator's EXISTING sudo path verbatim
#     (the root-owned 0600 Compose/env files are already managed this way in
#     the paired releases on record; gamja-ops runbooks). No new privileges.
#   * Compare-and-set everywhere: transitions only from the pinned OLD image
#     identity; any third-party drift halts with a stable code; never retries.
#   * Output discipline: stdout carries ONLY whitelisted one-line status
#     records. Raw stderr goes to 0600 receipt logs. Secrets (env values,
#     dumps, provider rows) are never echoed and never placed in argv.
#   * The migration applies ONLY when the pending inventory computed from the
#     LOADED candidate image is exactly the one approved WorkspacePlanning-
#     State migration. Anything else halts (code 22).
#   * Rollback = compose image revert to the pinned OLD ref + backend
#     recreate ONLY. It never touches the database; the WorkspacePlanningState
#     table and its rows are retained by policy. No destructive verbs exist
#     in this file against the production database (the ONLY DROP is the
#     rehearsal temp database created minutes earlier by this same job).
set -euo pipefail
umask 077
# Root gate. The ONLY test bypass (LCM_HELPER_ALLOW_NONROOT_TEST=1 together
# with an explicit LCM_ROOT) is exercised exclusively by fixture tests; the
# workflow never sets it (asserted structurally in pipeline.test.ts).
if [ "$(id -u)" != 0 ]; then
  if [ "${LCM_HELPER_ALLOW_NONROOT_TEST:-0}" != 1 ] || [ -z "${LCM_ROOT:-}" ]; then
    echo "helper: must run under the operator sudo (root)" >&2
    exit 2
  fi
fi

# ---------------- pinned constants (mirrored in scripts/ci/api/constants.mjs) --
LCM_ROOT="${LCM_ROOT:-/opt/livingcost}"
COMPOSE_FILE=$LCM_ROOT/docker-compose.yml
COMPOSE_PROJECT=livingcost
BACKEND_CONTAINER=livingcost-backend
OLD_SHA=a2c7bd9af46d84dc88b2a36656c25949b57076b0
OLD_REF='lcm-coaching-a2c7bd9af46d84dc88b2a36656c25949b57076b0@sha256:5d133132b544a0d5b07d471dab7e4a8a1dfb51d491be12ab7c7bb36c14ce667f'
OLD_IMAGE_ID=sha256:5d133132b544a0d5b07d471dab7e4a8a1dfb51d491be12ab7c7bb36c14ce667f
PG_CONTAINER=gamja-data-postgres
PG_SUPERUSER=gamja_admin
DB_NAME=livingcost
DB_SCHEMA=lcm
API_ENV_FILE=$LCM_ROOT/api/.env
BACKUPS_ROOT=$LCM_ROOT/backups
ROLLBACK_DIR=$LCM_ROOT/backups/rollback
REMINDER_TIMER=livingcost-reminders.timer
BACKEND_DB_NETWORK=gamja-data_default
PENDING_EXPECTED=20261018110000_workspace_planning_state
PENDING_SQL_SHA=229a1fa43233f74fef9110bf4d56307efbee93da1f8baeac3a3347588d1feb35
TABLES_BEFORE=24
MIG_ROWS_BEFORE=12
APPLIED_BEFORE=11
# Pinned known-applied set BEFORE promotion (names only; measured read-only
# 2026-10-19: exactly these 11 finished rows + 12 total rows incl. one
# pre-historical failed-marker of the initial migration which Prisma treats
# as applied baseline — see docs; a re-run of `migrate deploy` on the same
# image succeeded with these rows present in the 2026-10-15 paired release).
APPLIED_EXPECTED="20260522000000_initial 20260526000000_auth_hardening 20260527120000_add_is_end_of_month 20260528000000_add_workspace_sync_version 20260529100000_add_push_subscription 20260605000000_add_push_delivery 20261003000000_billing_anchor_renewal 20261006160000_budget_templates 20261007120000_service_billing_foundation 20261010000000_user_product_tour_state 20261015120000_private_coaching_preferences"
OCI_FLOOR_GIB=4
MAX_DUMP_BYTES=1073741824
MAX_ARCHIVE_BYTES=3221225472
NEW_REF_PREFIX=lcm-ci-api-

status() { printf 'op=%s %s\n' "$OP" "$*"; }
halt() { status "result=halt code=$1 detail=$2"; exit "$1"; }

# ---------------- args ----------------
OP="${1:-}"; shift || true
SHA=""; RUN=""; ATTEMPT=""; IMAGE_ID=""; ARCHIVE_SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA="${2:-}"; shift 2;;
    --run) RUN="${2:-}"; shift 2;;
    --attempt) ATTEMPT="${2:-}"; shift 2;;
    --image-id) IMAGE_ID="${2:-}"; shift 2;;
    --archive-sha) ARCHIVE_SHA="${2:-}"; shift 2;;
    *) halt 20 "unknown-arg";;
  esac
done
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || halt 20 "sha-not-40hex"
[[ "$RUN" =~ ^[0-9]{1,15}$ ]] || halt 20 "run-not-numeric"
[[ "$ATTEMPT" =~ ^[0-9]{1,4}$ ]] || halt 20 "attempt-not-numeric"
NEW_TAG="${NEW_REF_PREFIX}${SHA}:candidate"
NEW_REF="$NEW_TAG"
RECEIPTS="$BACKUPS_ROOT/actions-${RUN}-${ATTEMPT}-${SHA:0:12}"
LOG="$RECEIPTS/stderr.log"

require_compose() {
  [ -f "$COMPOSE_FILE" ] || halt 20 "compose-missing"
  [ ! -L "$COMPOSE_FILE" ] || halt 20 "compose-is-symlink"
}
compose_backend_ref() {
  # extract ONLY the backend service's image line (fixed parse, no eval)
  awk '
    /^services:[[:space:]]*$/ {insvc=1; next}
    /^[^[:space:]]/ {insvc=0}
    insvc && /^  backend:[[:space:]]*$/ {inb=1; next}
    inb && /^[[:space:]]{4,}/ {
      if ($1=="image:") { sub(/^[[:space:]]*image:[[:space:]]*/,""); print; exit }
      next
    }
    inb && !/^[[:space:]]{4,}/ {inb=0}
  ' "$COMPOSE_FILE"
}
db() { # SQL via stdin (never argv); raw errors to receipt log only
  docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$DB_NAME" -At -F'|' 2>>"${LOG:-/dev/null}"
}
df_ok() {
  local avail_k
  avail_k=$(df -Pk "$LCM_ROOT" | awk 'NR==2{print $4}')
  [ "${avail_k:-0}" -ge $((OCI_FLOOR_GIB*1024*1024)) ]
}
catalog_applied() {
  db <<'SQL' | sed '/^[[:space:]]*$/d'
SELECT migration_name FROM lcm._prisma_migrations
WHERE finished_at IS NOT NULL ORDER BY 1;
SQL
}
classify() {
  # echoes: fresh | promote-only | promoted | halt:<code>:<reason>
  local ref applied aborted planning_applied a extra n
  ref=$(compose_backend_ref)
  if ! applied=$(catalog_applied); then echo "halt:25:db-unreachable"; return; fi
  if ! aborted=$(db <<'SQL'
SELECT migration_name FROM lcm._prisma_migrations
WHERE finished_at IS NULL AND rolled_back_at IS NULL;
SQL
  ); then echo "halt:25:db-unreachable"; return; fi
  [ -z "$aborted" ] || { echo "halt:22:aborted-migration-rows"; return; }
  extra=0
  for a in $applied; do
    case " $APPLIED_EXPECTED $PENDING_EXPECTED " in
      *" $a "*) ;;
      *) extra=1;;
    esac
  done
  [ "$extra" = 0 ] || { echo "halt:22:unexpected-applied-migration"; return; }
  n=$(printf '%s\n' $applied | grep -c . || true)
  planning_applied=0
  printf '%s\n' "$applied" | grep -qx "$PENDING_EXPECTED" && planning_applied=1
  case "$ref" in
    "$OLD_REF")
      if [ "$planning_applied" = 0 ] && [ "$n" = "$APPLIED_BEFORE" ]; then echo fresh
      elif [ "$planning_applied" = 1 ] && [ "$n" = "$((APPLIED_BEFORE+1))" ]; then echo promote-only
      else echo "halt:22:applied-count"; fi ;;
    "$NEW_REF")
      if [ "$planning_applied" = 1 ]; then echo promoted
      else echo "halt:29:compose-candidate-without-migration"; fi ;;
    "") echo "halt:20:compose-parse";;
    *)  echo "halt:21:compose-cas-stale";;
  esac
}
mkdir_receipts() {
  mkdir -p "$RECEIPTS"; chmod 700 "$RECEIPTS"
  : >>"$LOG"; chmod 600 "$LOG"
}
manifest_get() { sed -n "s/^$1=//p" "$RECEIPTS/backup.manifest" | head -1; }

# ---------------- ops ----------------
case "$OP" in
  preflight)
    require_compose
    mkdir_receipts
    df_ok || halt 24 "oci-capacity-below-floor"
    [ "$(docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null || echo false)" = true ] \
      || halt 21 "backend-not-running"
    [ "$(docker inspect -f '{{.Image}}' "$BACKEND_CONTAINER")" = "$OLD_IMAGE_ID" ] \
      || halt 21 "backend-image-id-stale"
    STATE=$(classify)
    case "$STATE" in
      halt:*) IFS=: read -r _ code reason <<<"$STATE"; halt "$code" "$reason";;
    esac
    TABLES=$(db <<'SQL'
SELECT count(*) FROM information_schema.tables WHERE table_schema='lcm';
SQL
) || halt 25 "db-query-failed"
    TIMER=$(systemctl is-active "$REMINDER_TIMER" 2>/dev/null || echo unknown)
    printf 'state=%s\ntables=%s\nreminder_timer=%s\nchecked_at=%s\n' \
      "$STATE" "$TABLES" "$TIMER" "$(date -u +%FT%TZ)" >"$RECEIPTS/preflight.json"
    chmod 600 "$RECEIPTS/preflight.json"
    status "result=ok state=$STATE tables=$TABLES reminder_timer=$TIMER"
    ;;

  ensure-rollback)
    require_compose
    mkdir_receipts
    ROLL_TGZ="$ROLLBACK_DIR/lcm-rollback-${OLD_IMAGE_ID:7:12}.tar.gz"
    ROLL_META="$ROLL_TGZ.meta"
    if [ -f "$ROLL_TGZ" ] && [ -f "$ROLL_META" ] \
       && grep -q "^image_id=$OLD_IMAGE_ID$" "$ROLL_META" \
       && [ "$(sha256sum "$ROLL_TGZ" | cut -d' ' -f1)" = "$(sed -n 's/^sha256=//p' "$ROLL_META" | head -1)" ]; then
      status "result=ok rollback=reused bytes=$(stat -c %s "$ROLL_TGZ")"
      exit 0
    fi
    df_ok || halt 24 "oci-capacity-below-floor"
    mkdir -p "$ROLLBACK_DIR"; chmod 700 "$ROLLBACK_DIR"
    docker image inspect "$OLD_IMAGE_ID" >/dev/null 2>>"$LOG" \
      || halt 21 "rollback-image-absent-repull-not-established"
    img_sz=$(docker image inspect -f '{{.Size}}' "$OLD_IMAGE_ID" 2>/dev/null || echo 0)
    [ "${img_sz:-0}" -le $((MAX_ARCHIVE_BYTES + MAX_ARCHIVE_BYTES/4)) ] \
      || halt 24 "rollback-image-over-budget"
    tmp="/tmp/lcm-rollback-$$.tar.gz"
    if ! docker save "$OLD_IMAGE_ID" | gzip -n >"$tmp" 2>>"$LOG"; then
      rm -f "$tmp"; halt 25 "rollback-save-failed"
    fi
    sz=$(stat -c %s "$tmp")
    [ "$sz" -gt 0 ] && [ "$sz" -le "$MAX_ARCHIVE_BYTES" ] || { rm -f "$tmp"; halt 24 "rollback-archive-size-invalid"; }
    install -m 600 "$tmp" "$ROLL_TGZ"; rm -f "$tmp"
    {
      printf 'image_id=%s\n' "$OLD_IMAGE_ID"
      printf 'revision=%s\n' "$OLD_SHA"
      printf 'bytes=%s\n' "$sz"
      printf 'sha256=%s\n' "$(sha256sum "$ROLL_TGZ" | cut -d' ' -f1)"
      printf 'created_at=%s\n' "$(date -u +%FT%TZ)"
      printf 'note=local-save-of-current-prod-image; registry re-pull NOT established; reuse-if-valid, never duplicate\n'
    } >"$ROLL_META"
    chmod 600 "$ROLL_META"
    status "result=ok rollback=created bytes=$sz"
    ;;

  load-image)
    [[ "$ARCHIVE_SHA" =~ ^[0-9a-f]{64}$ ]] || halt 20 "archive-sha-malformed"
    [[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || halt 20 "image-id-malformed"
    mkdir_receipts
    ARC="$RECEIPTS/image.tar.gz"
    [ -f "$ARC" ] || halt 23 "archive-not-staged"
    [ ! -L "$ARC" ] || halt 20 "archive-is-symlink"
    sz=$(stat -c %s "$ARC")
    [ "$sz" -le "$MAX_ARCHIVE_BYTES" ] || halt 24 "archive-over-budget"
    got=$(sha256sum "$ARC" | cut -d' ' -f1)
    [ "$got" = "$ARCHIVE_SHA" ] || halt 23 "archive-sha-mismatch"
    loadout=$(docker load -i "$ARC" 2>>"$LOG") || { status "loadout-fail"; halt 23 "docker-load-failed"; }
    printf '%s\n' "$loadout" >>"$LOG"
    # Real-world fact (verified with docker 29 on 2026-10-19): saving by
    # immutable image ID LOADS back as "Loaded image ID: <id>" WITHOUT a tag.
    # Accept both forms; in ID form we create the pinned tag ourselves.
    loaded_id=$(printf '%s' "$loadout" | sed -n 's/^Loaded image ID: //p' | head -1)
    loaded_tag=$(printf '%s' "$loadout" | sed -n 's/^Loaded image: //p' | head -1)
    if [ -n "$loaded_id" ]; then
      [ "$loaded_id" = "$IMAGE_ID" ] || halt 23 "loaded-image-id-mismatch"
      docker tag "$loaded_id" "$NEW_TAG" 2>>"$LOG" || halt 23 "retag-failed"
    elif [ -n "$loaded_tag" ]; then
      [ "$loaded_tag" = "$NEW_TAG" ] || halt 23 "loaded-tag-unexpected"
    else
      halt 23 "docker-load-unknown-output"
    fi
    id=$(docker image inspect -f '{{.Id}}' "$NEW_TAG" 2>/dev/null || echo none)
    [ "$id" = "$IMAGE_ID" ] || halt 23 "loaded-image-id-mismatch"
    lbl=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NEW_TAG" 2>/dev/null || echo none)
    [ "$lbl" = "$SHA" ] || halt 23 "loaded-revision-label-mismatch"
    printf '%s\n' "$id" >"$RECEIPTS/candidate-image.txt"
    chmod 600 "$RECEIPTS/candidate-image.txt"
    status "result=ok tag=$NEW_TAG image_id=$id"
    ;;

  backup)
    require_compose
    mkdir_receipts
    STATE=$(classify)
    case "$STATE" in
      halt:*) IFS=: read -r _ code reason <<<"$STATE"; halt "$code" "$reason";;
      promoted) status "result=ok state=promoted backup=skip-already-current"; exit 0;;
    esac
    df_ok || halt 24 "oci-capacity-below-floor"
    STAMP=$(date -u +%Y%m%dT%H%M%SZ)
    DUMP="$RECEIPTS/livingcost-$STAMP.dump"
    tmp="/tmp/lcm-dump-$STAMP.dump"
    if ! docker exec "$PG_CONTAINER" pg_dump -U "$PG_SUPERUSER" -Fc "$DB_NAME" >"$tmp" 2>>"$LOG"; then
      rm -f "$tmp"; halt 25 "pg_dump-failed"
    fi
    sz=$(stat -c %s "$tmp")
    [ "$sz" -gt 0 ] && [ "$sz" -le "$MAX_DUMP_BYTES" ] || { rm -f "$tmp"; halt 25 "dump-size-invalid"; }
    install -m 600 "$tmp" "$DUMP"; rm -f "$tmp"
    ds=$(sha256sum "$DUMP" | cut -d' ' -f1)
    TABLES=$(db <<'SQL'
SELECT count(*) FROM information_schema.tables WHERE table_schema='lcm';
SQL
) || halt 25 "db-query-failed"
    HR=$(db <<'SQL'
SELECT count(*) FROM lcm._prisma_migrations;
SQL
) || halt 25 "db-query-failed"
    AP=$(printf '%s\n' "$(catalog_applied)" | grep -c . || true)
    {
      printf 'dump=%s\n' "$(basename "$DUMP")"
      printf 'bytes=%s\n' "$sz"
      printf 'sha256=%s\n' "$ds"
      printf 'db=%s\nschema=%s\nstamp=%s\nstate=%s\n' "$DB_NAME" "$DB_SCHEMA" "$STAMP" "$STATE"
      printf 'tables=%s\nmig_rows=%s\napplied=%s\n' "$TABLES" "$HR" "$AP"
    } >"$RECEIPTS/backup.manifest"
    # structural fingerprints of PRE-EXISTING tables (new table excluded)
    COL=$(db <<'SQL'
SELECT md5(string_agg(r, '|' ORDER BY r)) FROM (
  SELECT table_name||'.'||column_name||':'||data_type||':len-'||coalesce(character_maximum_length::text,'-') AS r
  FROM information_schema.columns
  WHERE table_schema='lcm' AND table_name<>'WorkspacePlanningState') s;
SQL
) || halt 25 "db-query-failed"
    CON=$(db <<'SQL'
SELECT md5(string_agg(r, '|' ORDER BY r)) FROM (
  SELECT con.conname||':'||c.relname AS r FROM pg_constraint con
  JOIN pg_class c ON c.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='lcm' AND c.relname<>'WorkspacePlanningState') s;
SQL
) || halt 25 "db-query-failed"
    printf 'cols=%s\n' "$COL" >"$RECEIPTS/columns.before.sha"
    printf 'cons=%s\n' "$CON" >"$RECEIPTS/constraints.before.sha"
    chmod 600 "$RECEIPTS"/* 2>/dev/null || true
    status "result=ok bytes=$sz sha256=$ds tables=$TABLES mig_rows=$HR"
    ;;

  rehearse)
    require_compose
    mkdir_receipts
    STATE=$(classify)
    case "$STATE" in
      halt:*) IFS=: read -r _ code reason <<<"$STATE"; halt "$code" "$reason";;
      promoted) status "result=ok state=promoted rehearse=skip-already-current"; exit 0;;
    esac
    DUMP=$(manifest_get dump)
    WANT_BYTES=$(manifest_get bytes)
    WANT_SHA=$(manifest_get sha256)
    WANT_TABLES=$(manifest_get tables)
    WANT_MIG=$(manifest_get mig_rows)
    [ -n "$DUMP$WANT_SHA" ] || halt 25 "backup-manifest-missing"
    case "$DUMP" in
      *[!A-Za-z0-9._-]*) halt 20 "manifest-dump-name-invalid";;
    esac
    [ -f "$RECEIPTS/$DUMP" ] && [ ! -L "$RECEIPTS/$DUMP" ] || halt 25 "backup-file-missing"
    [ "$(sha256sum "$RECEIPTS/$DUMP" | cut -d' ' -f1)" = "$WANT_SHA" ] || halt 23 "backup-integrity"
    [ "$(stat -c %s "$RECEIPTS/$DUMP")" = "$WANT_BYTES" ] || halt 23 "backup-size-drift"
    df_ok || halt 24 "oci-capacity-below-floor"
    TMPDB="lcm_rehearse_${RUN}_${ATTEMPT}_$(date -u +%H%M%S)"
    [[ "$TMPDB" =~ ^lcm_rehearse_[0-9_]{4,30}$ ]] || halt 20 "rehearse-db-name-invalid"
    if ! db >/dev/null <<SQL
CREATE DATABASE $TMPDB OWNER $PG_SUPERUSER;
SQL
    then halt 25 "rehearse-createdb-failed"; fi
    rc=0
    docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_SUPERUSER" -d "$TMPDB" \
      <"$RECEIPTS/$DUMP" >>"$RECEIPTS/restore.log" 2>>"$LOG" || rc=$?
    rt=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$TMPDB" -At -c \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='lcm';" 2>>"$LOG" || echo -1)
    rmq=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$TMPDB" -At -c \
      'SELECT count(*) FROM lcm._prisma_migrations;' 2>>"$LOG" || echo -1)
    drop_rc=0
    docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -Atc \
      "DROP DATABASE IF EXISTS $TMPDB WITH (FORCE);" >/dev/null 2>>"$LOG" || drop_rc=1
    ok=1
    [ "$rc" = 0 ] || ok=0
    [ "$rt" = "$WANT_TABLES" ] || ok=0
    [ "$rmq" = "$WANT_MIG" ] || ok=0
    [ "$drop_rc" = 0 ] || ok=0
    if [ "$ok" != 1 ]; then
      # best-effort cleanup; NEVER leave rehearsal DB behind on failure either
      docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -Atc \
        "DROP DATABASE IF EXISTS $TMPDB WITH (FORCE);" >/dev/null 2>>"$LOG" || true
      halt 25 "rehearse-verification-failed rc=$rc tables=$rt/$WANT_TABLES mig=$rmq/$WANT_MIG drop=$drop_rc"
    fi
    printf 'restored_tables=%s\nrestored_mig_rows=%s\ntempdb=%s\ntempdb_dropped=true\nrehearsed_at=%s\n' \
      "$rt" "$rmq" "$TMPDB" "$(date -u +%FT%TZ)" >"$RECEIPTS/rehearse.json"
    chmod 600 "$RECEIPTS/rehearse.json"
    status "result=ok restored_tables=$rt mig_rows=$rmq tempdb_dropped=true"
    ;;

  migrate)
    require_compose
    mkdir_receipts
    STATE=$(classify)
    case "$STATE" in
      halt:*) IFS=: read -r _ code reason <<<"$STATE"; halt "$code" "$reason";;
      promote-only) status "result=ok state=promote-only migrate=skip-already-applied"; exit 0;;
      promoted)     status "result=ok state=promoted migrate=skip-noop"; exit 0;;
    esac
    [ "$STATE" = fresh ] || halt 29 "unexpected-state"
    REC_ID=$(sed -n '1p' "$RECEIPTS/candidate-image.txt" 2>/dev/null || echo none)
    [ "$REC_ID" != none ] || halt 23 "candidate-image-not-loaded"
    if [ -n "$IMAGE_ID" ] && [ "$IMAGE_ID" != "$REC_ID" ]; then halt 23 "candidate-image-id-arg-drift"; fi
    [ "$(docker image inspect -f '{{.Id}}' "$NEW_TAG" 2>/dev/null || echo none)" = "$REC_ID" ] \
      || halt 23 "candidate-image-changed-since-load"
    dirs=$(docker run --rm "$NEW_TAG" sh -c 'for d in prisma/migrations/*/; do basename "$d"; done' 2>>"$LOG" | sed '/^[[:space:]]*$/d' | sort) \
      || halt 23 "image-migration-list-failed"
    printf '%s\n' "$dirs" >"$RECEIPTS/migration-dirs.txt"
    applied=$(catalog_applied | sort)
    pending=$(comm -13 <(printf '%s\n' "$applied") <(printf '%s\n' "$dirs"))
    pc=$(printf '%s\n' "$pending" | grep -c . || true)
    if [ "$pc" != 1 ] || [ "$pending" != "$PENDING_EXPECTED" ]; then
      printf 'pending_count=%s\n' "$pc" >>"$RECEIPTS/pending-rejection.json"
      printf '%s\n' "$pending" >>"$RECEIPTS/pending-rejection.json"
      chmod 600 "$RECEIPTS/pending-rejection.json"
      halt 22 "pending-inventory-not-exactly-approved"
    fi
    img_sha=$(docker run --rm "$NEW_TAG" sha256sum \
      "prisma/migrations/$PENDING_EXPECTED/migration.sql" 2>>"$LOG" | cut -d' ' -f1) || img_sha=none
    [ "$img_sha" = "$PENDING_SQL_SHA" ] || halt 23 "planning-sql-hash-mismatch"
    # Apply from the candidate image with the EXISTING protected env file —
    # values are injected by docker (never argv/stdout). The SQL itself is a
    # single transaction bounded by lock_timeout=5s / statement_timeout=30s.
    rc=0
    timeout 240 docker run --rm \
      --env-file "$API_ENV_FILE" \
      --network "$BACKEND_DB_NETWORK" \
      --label "lcm-ci-op=migrate-${RUN}-${ATTEMPT}" \
      "$NEW_TAG" sh -c './node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma' \
      >>"$RECEIPTS/migrate.log" 2>>"$LOG" || rc=$?
    if [ "$rc" != 0 ]; then
      printf 'prisma_rc=%s\ninspected_at=%s\n' "$rc" "$(date -u +%FT%TZ)" >>"$RECEIPTS/migrate-failure.json"
      catalog_applied | sort >>"$RECEIPTS/migrate-failure.json" 2>/dev/null || true
      chmod 600 "$RECEIPTS/migrate-failure.json" 2>/dev/null || true
      halt 26 "migrate-failed rc=$rc inspect-before-any-retry compose-untouched"
    fi
    planning_now=$(db <<'SQL'
SELECT to_regclass('lcm."WorkspacePlanningState"') IS NOT NULL;
SQL
) || planning_now=?
    [ "$planning_now" = t ] || halt 26 "planning-table-absent-after-migrate"
    status "result=ok planning_table=created"
    ;;

  promote)
    require_compose
    mkdir_receipts
    STATE=$(classify)
    case "$STATE" in
      halt:*) IFS=: read -r _ code reason <<<"$STATE"; halt "$code" "$reason";;
      promoted) status "result=ok promote=skip-already-current"; exit 0;;
    esac
    [ -s "$RECEIPTS/rehearse.json" ] || halt 25 "rehearse-evidence-missing"
    [ -s "$RECEIPTS/backup.manifest" ] || halt 25 "backup-evidence-missing"
    id=$(docker image inspect -f '{{.Id}}' "$NEW_TAG" 2>/dev/null || echo none)
    REC_ID=$(sed -n '1p' "$RECEIPTS/candidate-image.txt" 2>/dev/null || echo none)
    [ "$id" = "$REC_ID" ] && [ "$id" != none ] || halt 23 "candidate-image-id-missing"
    cp -p "$COMPOSE_FILE" "$RECEIPTS/docker-compose.before.yml"
    cur=$(compose_backend_ref)
    [ "$cur" = "$OLD_REF" ] || halt 21 "compose-cas-race"
    if ! python3 - "$COMPOSE_FILE" "$OLD_REF" "$NEW_REF" "$RECEIPTS/docker-compose.next.yml" <<'PY'
import sys
src, old, new, out = sys.argv[1:5]
text = open(src).read()
if text.count(old) != 1:
    sys.exit(1)
open(out, "w").write(text.replace(old, new, 1))
PY
    then halt 27 "compose-rewrite-refcount"; fi
    diff_rc=0
    diff -u "$COMPOSE_FILE" "$RECEIPTS/docker-compose.next.yml" >"$RECEIPTS/compose.diff" || diff_rc=$?
    changed=$(grep -c '^[+-][^+-]' "$RECEIPTS/compose.diff" || true)
    [ "$changed" = 2 ] || halt 27 "compose-diff-not-single-line"
    install -m 600 "$RECEIPTS/docker-compose.next.yml" "$COMPOSE_FILE"
    rc=0
    timeout 180 docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-deps backend \
      >>"$RECEIPTS/promote.log" 2>>"$LOG" || rc=$?
    if [ "$rc" != 0 ]; then
      # immediate service revert (compose file only — data untouched)
      install -m 600 "$RECEIPTS/docker-compose.before.yml" "$COMPOSE_FILE"
      timeout 180 docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-deps backend \
        >>"$RECEIPTS/promote-autorevert.log" 2>>"$LOG" || true
      halt 27 "compose-up-failed rc=$rc compose-reverted-old"
    fi
    ready=false
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 \
             21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 \
             41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60; do
      body=$(docker exec "$BACKEND_CONTAINER" node -e \
        "fetch('http://127.0.0.1:4000'+(process.env.API_BASE_PATH||'')+'/health').then(x=>x.json()).then(j=>process.stdout.write(String(j.commitSha))).catch(()=>{})" 2>/dev/null || true)
      [ "$body" = "$SHA" ] && { ready=true; break; }
      sleep 1
    done
    if [ "$ready" != true ]; then
      # health identity timeout: leave compose at candidate for inspection —
      # the migration+image are correct; auto-reverting could thrash a slow
      # cold start. CI verify-public step will re-confirm or halt.
      halt 27 "health-identity-timeout kept-for-inspection"
    fi
    status "result=ok container_image=$id health=sha-match"
    ;;

  verify)
    require_compose
    mkdir_receipts
    STATE=$(classify)
    [ "$STATE" = promoted ] || halt 29 "verify-requires-promoted-state"
    TABLES=$(db <<'SQL'
SELECT count(*) FROM information_schema.tables WHERE table_schema='lcm';
SQL
) || halt 25 "db-query-failed"
    [ "$TABLES" = "$((TABLES_BEFORE+1))" ] || halt 28 "tables-after-mismatch"
    AP=$(printf '%s\n' "$(catalog_applied)" | grep -c . || true)
    [ "$AP" = "$((APPLIED_BEFORE+1))" ] || halt 28 "applied-count-mismatch"
    HR=$(db <<'SQL'
SELECT count(*) FROM lcm._prisma_migrations;
SQL
) || halt 25 "db-query-failed"
    [ "$HR" = "$((MIG_ROWS_BEFORE+1))" ] || halt 28 "history-rows-mismatch"
    COL=$(db <<'SQL'
SELECT md5(string_agg(r, '|' ORDER BY r)) FROM (
  SELECT table_name||'.'||column_name||':'||data_type||':len-'||coalesce(character_maximum_length::text,'-') AS r
  FROM information_schema.columns
  WHERE table_schema='lcm' AND table_name<>'WorkspacePlanningState') s;
SQL
) || halt 25 "db-query-failed"
    want_col=$(sed -n 's/^cols=//p' "$RECEIPTS/columns.before.sha" | head -1)
    [ "$COL" = "$want_col" ] || halt 28 "existing-columns-changed"
    CON=$(db <<'SQL'
SELECT md5(string_agg(r, '|' ORDER BY r)) FROM (
  SELECT con.conname||':'||c.relname AS r FROM pg_constraint con
  JOIN pg_class c ON c.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='lcm' AND c.relname<>'WorkspacePlanningState') s;
SQL
) || halt 25 "db-query-failed"
    want_con=$(sed -n 's/^cons=//p' "$RECEIPTS/constraints.before.sha" | head -1)
    [ "$CON" = "$want_con" ] || halt 28 "existing-constraints-changed"
    EMPTY=$(db <<'SQL'
SELECT count(*)=0 FROM lcm."WorkspacePlanningState";
SQL
) || EMPTY=?
    printf 'tables=%s\napplied=%s\nhistory=%s\nplanning_empty_at_release=%s\nverified_at=%s\n' \
      "$TABLES" "$AP" "$HR" "$EMPTY" "$(date -u +%FT%TZ)" >"$RECEIPTS/verify.json"
    chmod 600 "$RECEIPTS/verify.json"
    status "result=ok tables=$TABLES applied=$AP history=$HR"
    ;;

  rollback-image)
    # MANUAL-OPERATOR ONLY (never wired into a workflow step). Reverts the
    # backend image string to the pinned OLD ref — database untouched, the
    # WorkspacePlanningState table and all rows are RETAINED by policy.
    require_compose
    mkdir_receipts
    cur=$(compose_backend_ref)
    [ "$cur" = "$NEW_REF" ] || halt 21 "rollback-cas-not-at-candidate"
    [ -f "$ROLLBACK_DIR/lcm-rollback-${OLD_IMAGE_ID:7:12}.tar.gz" ] \
      || halt 21 "rollback-archive-missing"
    docker image inspect "$OLD_IMAGE_ID" >/dev/null 2>>"$LOG" \
      || halt 21 "rollback-image-absent"
    cp -p "$COMPOSE_FILE" "$RECEIPTS/docker-compose.pre-rollback.yml"
    python3 - "$COMPOSE_FILE" "$NEW_REF" "$OLD_REF" <<'PY'
import sys
src, old, new = sys.argv[1:4]
text = open(src).read()
if text.count(old) != 1:
    sys.exit(1)
open(src, "w").write(text.replace(old, new, 1))
PY
    [ "$(compose_backend_ref)" = "$OLD_REF" ] || halt 27 "rollback-cas-post-write"
    rc=0
    timeout 180 docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-deps backend \
      >>"$RECEIPTS/rollback.log" 2>>"$LOG" || rc=$?
    [ "$rc" = 0 ] || halt 27 "rollback-compose-up-failed"
    id=$(docker inspect -f '{{.Image}}' "$BACKEND_CONTAINER")
    [ "$id" = "$OLD_IMAGE_ID" ] || halt 27 "rollback-image-id-mismatch"
    status "result=ok rollback=old-image DB-and-planning-retained"
    ;;

  install-check)
    # Called right after CI copies this file: proves the executed bytes are
    # the reviewed bytes. The expected SHA256 is computed from THIS checkout.
    status "result=ok helper_sha256=$(sha256sum "$0" | cut -d' ' -f1)"
    ;;

  *)
    echo "helper: op not in allowlist" >&2
    exit 20
    ;;
esac
