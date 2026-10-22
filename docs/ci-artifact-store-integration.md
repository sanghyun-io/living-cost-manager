# Production artifact-store hook (local source change)

The workflow and test mock now pin the internally installed common bundle at
`$HOME/.local/share/gamjaworld-cli/releases/38669d285e6df82afe1f70b063096c4a12d637924e56fd8919d345774daad5f9`.
The public CLI versions remain `opskv 0.2.0` and `artifact-store 0.2.0`; this
is a changed content fingerprint. No bundle code, protected artifact-store
configuration, OpsKV value, or credential was copied or changed in this repo.

The gated API and Pages production jobs invoke the pinned internal bundle's
contract/target preflight before their production mutation. After the existing
API identity/health gates and promoted-reference CAS, the API job offers its
already-created `image.tar.gz` plus trace metadata. After the existing Pages
deployment and public release-identity checks, the FE job packages the
already-downloaded release fixture (including relative paths) into a temporary
tarball and offers that single file. Before writing it, a local helper measures
every regular file in the bounded `release` tree and checks available space
against `15GiB floor + 1GiB reserve + ceil(raw bytes × 1.2) + per-entry tar overhead`;
policy constants have no runtime override. The temporary package is removed on
exit. Each component has a separate SHA/run/attempt identity. Archive errors remain non-fatal and do not
replay deployment, CAS, or rollback. API metadata is trace-only; it is not an
image backup. No extra Docker save or cross-run artifact download is added.
If post-promotion external API archiving fails, the exact local `dist-api`
image tar and metadata are retained and reported for operator recovery; normal
success removes them after the existing remote cleanup. The remote production
image and its rollback archive remain the established recovery origins.

The prior integration is already on feature branch commit `a3b016b`, which was
pushed earlier but has no PR/main merge. This task's updated pin, AGENT guidance,
and readiness note are local uncommitted edits only. The workflow contract tests
passed 6/6, the budget tests passed 4/4, and workflow YAML parsing plus
`git diff --check` passed. Tests use mock pipeline helpers and local fixtures;
no OpsKV, Drive, service API, SSH, or live preflight was called. No workflow was triggered,
deployed, newly published, committed, pushed, or merged by this task. CI UID/
runner registration, OpsKV contract enablement, and installed artifact-store
authorization remain runtime prerequisites and were not queried or changed.
