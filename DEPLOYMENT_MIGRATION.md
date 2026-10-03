# Current production deployment ownership

Live verified 2026-10-03: frontend is Cloudflare Pages; API and database run on OCI.
Mac is development/CI/on-demand staging only. The July Mac gamja-deployer
launchd/current-symlink description is historical and is not a recovery procedure.

The current operation is an explicit, paired operator deployment:

1. Build the OCI image from an exact clean Git commit with `--build-arg RELEASE_SHA=<SHA>`.
2. Push to the existing OCIR `livingcost/backend` repository and verify registry digest/pull.
3. Use `/opt/livingcost/docker-compose.yml`, existing networks and protected API env.
   Pin backend to the verified image digest and recreate only backend.
4. Build static FE with `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1`.
   Run `node scripts/write-release-meta.mjs <SHA>` and deploy with existing Wrangler
   Pages credentials to project `living-cost-manager`, production branch `main`.
5. Compare API `/living-cost-manager/v1/health` `commitSha`, `releaseId` and
   `X-Release-Sha` with FE `/release-meta.json`. Verify public guide routes and flows.

Automatic push-to-main frontend deployment remains retired. Do not restore it
independently of backend promotion/rollback. The checked-in API-test workflow is
validation only, not a production deployment pipeline.

Restart recovery pulls the pinned registry digest and uses the existing Compose/env;
it must not rebuild from mutable main. Preserve compatible billing-field writes on
rollback: the pre-billing API is not a safe writable rollback target.

Details, backups, verification evidence and rollback boundaries:
[2026-10-03 release record](docs/production-release-20261003.md).

## Readiness and maintenance boundaries

`/health` is process liveness and identity, not DB readiness. The current backend
has no Docker healthcheck. `restart: unless-stopped` only recovers process exits;
it does not recover a hung application. On failure, check API request timeouts,
container logs and a DB roundtrip before deciding whether to recreate backend.
Use a read-only DB roundtrip without printing rows:

```sh
docker exec -w /app livingcost-backend node --input-type=module -e \
 'import {PrismaClient} from "@prisma/client"; const p=new PrismaClient(); try { await p.$queryRaw`SELECT 1`; console.log("database-ready"); } finally { await p.$disconnect(); }'
```

DB restore is a separate, explicitly approved destructive operation; it is not
part of normal deployment or rollback. Before any approved restore:

1. Record whether `livingcost-reminders.timer` is active, then stop that timer
   and `livingcost-reminders.service` to prevent reminders during recovery.
2. Stop only this backend: `docker compose -p livingcost -f
   /opt/livingcost/docker-compose.yml stop backend`. Keep other services running.
3. Confirm `docker inspect livingcost-backend --format '{{.State.Running}}'`
   is false and public authenticated snapshot writes fail. Verify no remaining
   sessions for database `livingcost` except the maintenance connection before
   restoring; abort if any unexpected writer remains. Do not automatically kill it.
4. Preserve a fresh protected backup. Restore only under the separately approved
   procedure; never drop shared PostgreSQL or restore it wholesale.
5. Start the compatible pinned backend, check DB roundtrip and authenticated
   read/write using a disposable account, then remove that account. Verify public
   health identity and matching FE metadata. Restore the timer only if previously active.

Registry recovery requires a fresh short-lived OCI login token. Existing shared
Docker credentials were stale. `oci --profile GAMJA --region ap-chuncheon-1
container-registry access-token get --endpoint https://yny.ocir.io` can obtain a
token with the existing API-key profile. Pipe its token field privately into
`docker --config <protected-temporary-dir> login yny.ocir.io -u BEARER_TOKEN
--password-stdin`; never print it. Pull the pinned digest, then logout that
temporary configuration. No IAM changes or permanent token creation are needed.
