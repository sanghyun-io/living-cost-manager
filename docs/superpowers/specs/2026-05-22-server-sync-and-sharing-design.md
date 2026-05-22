# Server Sync and Sharing Design

## Goal

Add a backend to the living cost manager while keeping the current GitHub Pages frontend. The first server-backed feature is account-based sync and backup. Family/workspace sharing comes next. Actual one-off spending and full household accounting are explicitly out of scope for this design.

## Priorities

1. Account-based sync and backup.
2. Workspace sharing for family or household management.
3. Actual spend tracking is deferred.

## Architecture

Use a monorepo:

```text
living-cost-manager/
  apps/
    web/
    api/
  packages/
    shared/
  prisma/
    schema.prisma
```

Responsibilities:

- `apps/web`: the existing Next static frontend deployed to GitHub Pages.
- `apps/api`: a Fastify API server deployed to an OCI VM.
- `packages/shared`: shared Zod schemas, DTO types, enums, and API contracts.
- `prisma/schema.prisma`: PostgreSQL database model.

The frontend must not import Prisma models directly. It should only import DTOs and schemas from `packages/shared`.

## Technology Choices

Backend:

- Fastify
- TypeScript
- Zod for request and response validation
- JWT authentication
- Prisma ORM
- PostgreSQL
- Docker Compose on OCI VM

Frontend:

- Existing Next static export
- GitHub Pages hosting
- Existing localStorage data remains available as offline cache and migration source

## Data Model

Core tables:

- `User`
- `Workspace`
- `WorkspaceMember`
- `Category`
- `PaymentCard`
- `FixedCost`
- `BackupSnapshot`

First release behavior:

- A user signs up or logs in.
- A personal workspace is created automatically for that user.
- Categories, cards, and fixed costs are saved under that workspace.
- The app can sync all workspace budget data between the server and the current browser.

Later sharing behavior:

- A workspace owner can invite members.
- Members can access the same workspace.
- Roles are `owner`, `editor`, and `viewer`.
- `owner` can manage members and all budget data.
- `editor` can edit budget data but cannot manage members.
- `viewer` can read budget data only.

## Shared API Contracts

`packages/shared` should define:

- `PaymentMethodId`
- `WorkspaceRole`
- `UserDto`
- `WorkspaceDto`
- `WorkspaceMemberDto`
- `CategoryDto`
- `PaymentCardDto`
- `FixedCostDto`
- create/update schemas for categories, cards, and fixed costs
- sync request and response schemas

`FixedCostDto` should preserve the current client model:

- `id`
- `workspaceId`
- `name`
- `categoryId`
- `paymentMethodId`
- `paymentOptionId`
- `amount`
- `periodMonths`
- `billingDay`

`periodMonths` remains a number rounded to one decimal place.

## Sync Model

Keep localStorage as a cache and fallback.

On login:

1. Load local browser data.
2. Load server workspace data.
3. If the server workspace is empty, offer to upload local data.
4. If both local and server data exist and differ, let the user choose:
   - use server data
   - upload this browser data
   - keep local-only for now

After sync is enabled:

- Normal edits update local state immediately.
- The app sends changes to the API.
- If the API call fails, localStorage keeps the latest browser state and the UI shows a sync warning.
- A manual "sync now" action retries pending changes.

## API Surface

Authentication:

- `POST /auth/register`
- `POST /auth/login`
- `GET /me`

Workspace:

- `GET /workspaces`
- `POST /workspaces`
- `GET /workspaces/:workspaceId`

Sync:

- `GET /workspaces/:workspaceId/snapshot`
- `PUT /workspaces/:workspaceId/snapshot`

Sharing, implemented after personal sync:

- `GET /workspaces/:workspaceId/members`
- `POST /workspaces/:workspaceId/invitations`
- `PATCH /workspaces/:workspaceId/members/:memberId`
- `DELETE /workspaces/:workspaceId/members/:memberId`

The first implementation should prefer snapshot sync over many fine-grained CRUD endpoints. This keeps the server migration smaller and matches the current client state shape.

## Security

Minimum requirements:

- Passwords are hashed with a modern password hashing function.
- JWT secrets are never committed.
- API CORS allows the GitHub Pages origin.
- Every workspace route verifies membership.
- Role checks are enforced on server mutations.
- Backups and snapshots are scoped to a workspace.

The allowed CORS origin for the current frontend is:

```text
https://sanghyun-io.github.io
```

The path `/living-cost-manager` is not part of the CORS origin.

## Deployment

Frontend:

- Keep GitHub Pages.
- Keep the current `/living-cost-manager` base path.
- Add an API base URL configuration for production builds.

Backend:

- Deploy `apps/api` to an OCI VM using Docker Compose.
- Run PostgreSQL in Docker for the first server release.
- Store environment variables on the VM, not in the repo.
- Use HTTPS through a reverse proxy before exposing auth endpoints publicly.

## Migration From Current App

The current app is localStorage-first. Server adoption should not destroy local data.

Migration flow:

1. User opens the existing Pages app.
2. User logs into the new server account.
3. App detects local browser data.
4. App asks whether to upload that local data to the personal workspace.
5. After upload, the server snapshot becomes the source of truth.

The `.lcm` full backup export/import remains available regardless of server sync.

## Testing

Backend tests:

- auth register/login
- workspace membership enforcement
- snapshot read/write
- role-based mutation rejection
- validation rejection for invalid fixed-cost period

Shared package tests:

- DTO schemas accept current fixed-cost/category/card shapes
- decimal `periodMonths` is preserved to one decimal place

Frontend tests:

- local-only mode still works
- login sync prompt appears when local data exists
- server snapshot can hydrate the dashboard
- failed sync leaves local edits intact and shows a warning

## Explicitly Out Of Scope

- One-off actual spend tracking
- Bank/card transaction import
- OCR receipts
- automated payment reminders
- native mobile app
- moving the frontend away from GitHub Pages
