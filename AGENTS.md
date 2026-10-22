# Repository Guidelines

## Gamja Ops Registry

Before infrastructure-affecting changes, read `.ai/gamja-ops-policy.md`.

That file is generated from the private `sanghyun-io/gamja-ops` repository.
Do not edit it manually.

## CI production configuration and artifact tools

- `opskv` is the source for CI contracts and validated operational settings; the canonical delivery command is `opskv deliver`. The existing LCM API CAS and production-environment approval/backup/rehearsal/rollback procedure remain authoritative. Do not replace them with common CLI calls, bulk `.env` delivery, or a new write path.
- The shared internal `artifact-store` archives only exact production artifacts after the existing mandatory health/identity gates. Its service target is selected by the approved mapped configuration; do not hardcode a provider/root in workflows or copy credentials/config into the repository. The pinned `pipeline.py preflight --service living-cost-manager` checks the fixed contract and service-target binding only, not deployment health or identity.
- API archive uses the already-produced `dist-api/image.tar.gz` and trace metadata after the existing CAS registration. Metadata is not an image backup. Preserve the existing production reviewer gate, CAS, backup/rehearsal, and rollback ownership. On archive failure do not retry deployment or rollback; preserve/report the exact local image files only under the existing workflow's conditional failure path.
- Pages archive occurs only after existing deployment and release-identity checks. Its local source-size/peak budget includes the 15GiB policy floor, actual measured payload ×1.2, and reserve; retain the code-reviewed constants and do not add environment threshold overrides. The temporary tar is task-owned and removed by its trap.
- Follow `.ai/gamja-ops-policy.md`, `docs/ci-artifact-store-integration.md`, and the [central CI/CD rollout ledger](https://github.com/sanghyun-io/gamja-ops/blob/main/docs/cicd-rollout-20261021.md). Local tests, remote CI, production verification, and artifact upload/readback are separate readiness states.
