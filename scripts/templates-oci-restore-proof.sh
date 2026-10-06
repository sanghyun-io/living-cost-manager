#!/usr/bin/env bash
# Run on OCI via SSH stdin. Only the explicitly owned disposable target is mutated.
set -euo pipefail
umask 077
backup=/opt/gamja-backup/postgres/daily/livingcost-2026-10-06T151322Z.dump
expected=f1e9ebe963ce87105fab8bbfded3bc1bab42e3669255454484afacdad38e0abd
release=/opt/livingcost/releases/templates-8c4e1282614a99c1654abdac0b3618ddd998d231
image=sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5
id="$(cat /proc/sys/kernel/random/uuid)"
target="lcm-restore-proof-$id"
for directory in /opt/livingcost /opt/livingcost/releases "$release"; do
  sudo test -d "$directory"
  sudo test ! -L "$directory"
done
receipt="$(sudo mktemp -d "$release/restore-proof-20261007.XXXXXX")"
sudo test ! -L "$receipt"
[[ "$(sudo stat -c '%a:%u' "$receipt")" == 700:0 ]] || exit 1
attempted=0
record_cleanup() {
  sudo sh -c 'umask 077; printf "%s\n" "$2" >> "$1/receipt.txt"' sh "$receipt" "$1"
}
cleanup() {
  local label remaining
  if [[ "$attempted" == 1 ]]; then
    if label=$(docker inspect "$target" --format '{{index .Config.Labels "lcm.restore.owner"}}' 2>/dev/null); then
      if [[ "$label" != "$id" ]]; then
        record_cleanup 'cleanup_failed=ownership_mismatch' || true
        return 1
      fi
      if ! docker rm -f -v "$target" >/dev/null 2>&1; then
        record_cleanup 'cleanup_failed=owned_target_remove_failed' || true
        return 1
      fi
      attempted=0
      record_cleanup 'owned_target_removed=true' || return 1
    else
      # Inspect failure is not proof of absence (e.g. unavailable Docker daemon).
      remaining=$(docker container ls -a --filter "name=^/$target$" --format '{{.Names}}' 2>/dev/null) || return 1
      [[ -z "$remaining" ]] || return 1
      attempted=0
      record_cleanup 'owned_target_absent=true' || return 1
    fi
  fi
}
finish() {
  local original=$? cleanup_status=0
  trap - EXIT
  cleanup || cleanup_status=$?
  if [[ "$cleanup_status" != 0 ]]; then
    printf 'Restore proof cleanup failed; no completed proof may be claimed.\n' >&2
  fi
  # Cleanup must not mask an earlier restore/startup/diagnostic failure.
  if [[ "$original" != 0 ]]; then exit "$original"; fi
  exit "$cleanup_status"
}
trap finish EXIT
capture_private() {
  local name=$1
  shift
  # Synchronous redirections: opening either diagnostic file must succeed before
  # executing the command, and its exit is checked by the caller's pipefail.
  sudo sh -c 'umask 077; set -C; out=$1; err=$2; shift 2; exec "$@" > "$out" 2> "$err"' \
    sh "$receipt/$name.stdout" "$receipt/$name.stderr" "$@"
}
sudo test ! -L "$backup"
[[ "$(sudo sha256sum "$backup" | cut -d' ' -f1)" == "$expected" ]] || exit 1
[[ "$(sudo stat -c %a "$backup")" == 600 ]] || exit 1
migration="$release/build/prisma/migrations/20261006160000_budget_templates/migration.sql"
sudo test -f "$migration"
sudo test ! -L "$migration"
docker image inspect "$image" >/dev/null
# Never arm cleanup for a pre-existing name. Run can create a target and then
# fail during startup, so arm BEFORE run rather than after its successful exit.
existing=$(docker container ls -a --filter "name=^/$target$" --format '{{.Names}}')
[[ -z "$existing" ]] || exit 1
attempted=1
docker run -d --pull=never --name "$target" --label "lcm.restore.owner=$id" \
  --network none --mount type=tmpfs,destination=/var/lib/postgresql/data \
  -e POSTGRES_USER=restore_owner -e POSTGRES_DB=restore_proof \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
for ((i=0;i<60;i++)); do
  if docker exec "$target" pg_isready -U restore_owner -d restore_proof >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$target" pg_isready -U restore_owner -d restore_proof >/dev/null
[[ "$(docker inspect "$target" --format '{{.HostConfig.NetworkMode}}')" == none ]] || exit 1
[[ "$(docker inspect "$target" --format '{{len .HostConfig.PortBindings}}')" == 0 ]] || exit 1
sudo cat "$backup" | capture_private restore docker exec -i "$target" pg_restore -U restore_owner -d restore_proof \
  --exit-on-error --no-owner --no-acl
printf 'source=%s\nsource_sha256=%s\ntarget=%s\nimage=%s\nnetwork=none\nhost_ports=0\npg_restore_exit=0\n' \
  "$backup" "$expected" "$target" "$image" | sudo tee "$receipt/receipt.txt" >/dev/null
docker exec "$target" pg_dump -U restore_owner -d restore_proof --schema-only --schema=lcm \
  --no-owner --no-acl | sudo tee "$receipt/schema.before.sql" >/dev/null
docker exec "$target" psql -U restore_owner -d restore_proof -Atqc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='lcm' AND table_type='BASE TABLE'" \
  | sudo tee "$receipt/tables.before.txt" >/dev/null
[[ "$(sudo cat "$receipt/tables.before.txt")" == 13 ]] || exit 1
{
  printf "BEGIN; SET LOCAL search_path=lcm; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n"
  sudo cat "$migration"
  printf '\nCOMMIT;\n'
} | capture_private migration docker exec -i "$target" psql -X -U restore_owner -d restore_proof -v ON_ERROR_STOP=1
docker exec "$target" pg_dump -U restore_owner -d restore_proof --schema-only --schema=lcm \
  --exclude-table='lcm."BudgetTemplate"' --exclude-table='lcm."BudgetTemplateShare"' --no-owner --no-acl \
  | sudo tee "$receipt/schema.after-existing.sql" >/dev/null
# PostgreSQL 16 random restriction markers are normalized for schema comparison only.
sudo sed '/^\\restrict /d; /^\\unrestrict /d' "$receipt/schema.before.sql" | sudo tee "$receipt/schema.before.normalized" >/dev/null
sudo sed '/^\\restrict /d; /^\\unrestrict /d' "$receipt/schema.after-existing.sql" | sudo tee "$receipt/schema.after.normalized" >/dev/null
sudo cmp "$receipt/schema.before.normalized" "$receipt/schema.after.normalized"
docker exec "$target" psql -U restore_owner -d restore_proof -Atqc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='lcm' AND table_type='BASE TABLE'" \
  | sudo tee "$receipt/tables.after.txt" >/dev/null
[[ "$(sudo cat "$receipt/tables.after.txt")" == 15 ]] || exit 1
docker exec "$target" psql -U restore_owner -d restore_proof -Atqc \
  "SELECT conname,contype,convalidated FROM pg_constraint WHERE conrelid IN ('lcm.\"BudgetTemplate\"'::regclass,'lcm.\"BudgetTemplateShare\"'::regclass) ORDER BY conname" \
  | sudo tee "$receipt/constraints.txt" >/dev/null
printf 'migration_exit=0\ntables_before=13\ntables_after=15\nexisting_schema_equal=true\ncustomer_rows_queried=false\n' \
  | sudo tee -a "$receipt/receipt.txt" >/dev/null
cleanup
sudo find "$receipt" -maxdepth 1 -type f -exec chmod 600 {} +
sudo chmod 700 "$receipt"
date -u '+completed_utc=%Y-%m-%dT%H:%M:%SZ' | sudo tee -a "$receipt/receipt.txt" >/dev/null
printf 'proof_complete=true\n' | sudo tee -a "$receipt/receipt.txt" >/dev/null
printf 'Restore proof receipt: %s\n' "$receipt"
sudo cat "$receipt/receipt.txt"
sudo cat "$receipt/constraints.txt"
