# Production artifact-store hook (local source change)

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

This is a local source integration only. No workflow was triggered, deployed,
published, committed, pushed, or merged. CI UID/runner registration, OpsKV
contract enablement, and installed artifact-store authorization remain runtime
prerequisites and were not tested or changed here.
