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
receipt="$(sudo mktemp -d "$release/restore-proof-20261007.XXXXXX")"
created=0
cleanup() {
  if [[ "$created" == 1 ]]; then
    label=$(docker inspect "$target" --format '{{index .Config.Labels "lcm.restore.owner"}}')
    [[ "$label" == "$id" ]] || return 1
    docker rm -f -v "$target" >/dev/null
    printf 'owned_target_removed=true\n' | sudo tee -a "$receipt/receipt.txt" >/dev/null
  fi
}
trap cleanup EXIT
[[ "$(sudo sha256sum "$backup" | cut -d' ' -f1)" == "$expected" ]]
[[ "$(sudo stat -c %a "$backup")" == 600 ]]
migration="$release/build/prisma/migrations/20261006160000_budget_templates/migration.sql"
sudo test -f "$migration"
docker image inspect "$image" >/dev/null
docker run -d --pull=never --name "$target" --label "lcm.restore.owner=$id" \
  --network none --mount type=tmpfs,destination=/var/lib/postgresql/data \
  -e POSTGRES_USER=restore_owner -e POSTGRES_DB=restore_proof \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
created=1
for ((i=0;i<60;i++)); do
  if docker exec "$target" pg_isready -U restore_owner -d restore_proof >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$target" pg_isready -U restore_owner -d restore_proof >/dev/null
[[ "$(docker inspect "$target" --format '{{.HostConfig.NetworkMode}}')" == none ]]
[[ "$(docker inspect "$target" --format '{{len .HostConfig.PortBindings}}')" == 0 ]]
sudo cat "$backup" | docker exec -i "$target" pg_restore -U restore_owner -d restore_proof \
  --exit-on-error --no-owner --no-acl > >(sudo tee "$receipt/restore.stdout" >/dev/null) \
  2> >(sudo tee "$receipt/restore.stderr" >/dev/null)
printf 'source=%s\nsource_sha256=%s\ntarget=%s\nimage=%s\nnetwork=none\nhost_ports=0\npg_restore_exit=0\n' \
  "$backup" "$expected" "$target" "$image" | sudo tee "$receipt/receipt.txt" >/dev/null
docker exec "$target" pg_dump -U restore_owner -d restore_proof --schema-only --schema=lcm \
  --no-owner --no-acl | sudo tee "$receipt/schema.before.sql" >/dev/null
docker exec "$target" psql -U restore_owner -d restore_proof -Atqc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='lcm' AND table_type='BASE TABLE'" \
  | sudo tee "$receipt/tables.before.txt" >/dev/null
[[ "$(sudo cat "$receipt/tables.before.txt")" == 13 ]]
{
  printf "BEGIN; SET LOCAL search_path=lcm; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n"
  sudo cat "$migration"
  printf '\nCOMMIT;\n'
} | docker exec -i "$target" psql -X -U restore_owner -d restore_proof -v ON_ERROR_STOP=1 \
  > >(sudo tee "$receipt/migration.stdout" >/dev/null) 2> >(sudo tee "$receipt/migration.stderr" >/dev/null)
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
[[ "$(sudo cat "$receipt/tables.after.txt")" == 15 ]]
docker exec "$target" psql -U restore_owner -d restore_proof -Atqc \
  "SELECT conname,contype,convalidated FROM pg_constraint WHERE conrelid IN ('lcm.\"BudgetTemplate\"'::regclass,'lcm.\"BudgetTemplateShare\"'::regclass) ORDER BY conname" \
  | sudo tee "$receipt/constraints.txt" >/dev/null
printf 'migration_exit=0\ntables_before=13\ntables_after=15\nexisting_schema_equal=true\ncustomer_rows_queried=false\n' \
  | sudo tee -a "$receipt/receipt.txt" >/dev/null
date -u '+completed_utc=%Y-%m-%dT%H:%M:%SZ' | sudo tee -a "$receipt/receipt.txt" >/dev/null
cleanup
created=0
sudo find "$receipt" -maxdepth 1 -type f -exec chmod 600 {} +
sudo chmod 700 "$receipt"
printf 'Restore proof receipt: %s\n' "$receipt"
sudo cat "$receipt/receipt.txt"
sudo cat "$receipt/constraints.txt"
