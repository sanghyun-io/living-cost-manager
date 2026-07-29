<!-- GENERATED FROM sanghyun-io/gamja-ops. DO NOT EDIT MANUALLY. -->
<!-- Source file: policies/agent-infra-registry-policy.md -->
<!-- Source commit: 1b1dfe97a25e12ceffe362a4cf966c9507958522 -->

# Gamja Ops Infrastructure Registry Policy

This file is the central operations policy for Sanghyun's personal services.
It is maintained in the private `sanghyun-io/gamja-ops` repository and is
distributed to service repositories as `.ai/gamja-ops-policy.md`.

## Required Rule

If a change affects runtime infrastructure, update `gamja-ops` in the same
working session.

`gamja-ops` is the non-secret source of truth for:

- services and process ownership
- public domains and Cloudflare routing
- database names and schemas
- backup jobs and restore locations
- scheduled workers and LaunchDaemons
- external provider callback URLs
- secret references and storage locations

## Infrastructure-Affecting Changes

Update `gamja-ops` when changing any of these:

- service ports, local bind addresses, health check paths, or process names
- LaunchDaemon labels, plist files, Docker Compose services, or scheduled jobs
- public hostnames, route prefixes, Cloudflare DNS, Tunnel, Pages, or Email Routing
- database name, schema name, database ownership, restore flow, or migration ownership
- backup scripts, backup paths, retention policy, offsite copy policy, or restore runbooks
- new, renamed, removed, or re-scoped environment variables or provider secrets
- OAuth redirect URLs, webhook URLs, callback URLs, CORS allowlists, or public API base URLs
- external providers such as payment, email, push, storage, analytics, search, or AI APIs
- service archival, shutdown, migration, or ownership transfer

Do not update `gamja-ops` for purely internal code changes that do not affect
deployment, routing, data ownership, secrets, backups, or provider configuration.

## Files To Update In `gamja-ops`

Use this mapping:

| Change | Registry file |
| --- | --- |
| New or changed service runtime | `assets/services.yaml` |
| Domain, registrar, DNS provider | `assets/domains.yaml` |
| Cloudflare zone, tunnel, DNS, email routing | `assets/cloudflare.yaml` |
| PostgreSQL database or schema ownership | `assets/databases.yaml` |
| Backup job, path, retention, restore location | `assets/backups.yaml` |
| Secret name, storage location, rotation note | `assets/secrets.yaml` |
| Repeatable operational procedure | `runbooks/*.md` |
| Agent policy distribution target | `targets/service-repos.yaml` |

Use `unknown` rather than guessing.

## Secret Handling

Never commit secret values to a service repo or to `gamja-ops`.

Allowed:

- secret names
- environment variable names
- provider names
- storage locations
- rotation notes
- non-secret IDs such as Cloudflare zone IDs or tunnel IDs

Forbidden:

- API token values
- app passwords
- OAuth client secrets
- database passwords
- private keys
- `.env` contents
- one-time verification codes
- customer data

If a secret is exposed in a diff or chat, remove it and rotate the provider
secret when practical.

## Verification

After updating `gamja-ops`, run from the `gamja-ops` repo:

```bash
ruby scripts/verify-assets.rb
ruby scripts/check-local-drift.rb
```

`verify-assets.rb` must pass before committing.

`check-local-drift.rb` is expected to run on the Mac mini home server. It may
not be meaningful inside GitHub Actions.

## Generated File Rule

In service repositories, `.ai/gamja-ops-policy.md` is generated from
`gamja-ops`.

Do not edit `.ai/gamja-ops-policy.md` manually. Change
`policies/agent-infra-registry-policy.md` in `gamja-ops`, then sync the policy.
