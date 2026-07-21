# Mac gamja-deployer deployment

Living Cost Manager API and frontend releases are owned by the Mac
`gamja-deployer`. The `staging` branch is promoted before `main`; a release
activates the API and Cloudflare Pages frontend with one exact commit identity.

`/living-cost-manager/v1/health` reports `releaseId` and `commitSha`; Pages
publishes the same values at `/release-meta.json`. launchd executes the API
from the environment-specific immutable `current` symlink.

The previous GitHub Actions direct Pages workflow and historical OCI runtime
instructions are retired. Runtime rollback is performed only with
`scripts/gamja-deploy rollback`, switching backend and Pages together before
exact-SHA verification.
