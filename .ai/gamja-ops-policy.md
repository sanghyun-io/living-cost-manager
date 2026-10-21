<!-- GENERATED FROM sanghyun-io/gamja-ops. DO NOT EDIT MANUALLY. -->
<!-- Source files: policies/agent-infra-registry-policy.md, policies/ci-cd-github-actions-macmini-runner-policy.md, policies/disk-capacity-management.md, policies/key-value-management.md -->
<!-- Source commit: 4af25e696ef1287dafbcf5a340fcca703b488b3f -->
<!-- Source worktree: clean -->
<!-- Policy body SHA-256: b2500faaa612d43c5486817e5df39b578a58d260d330d01d85c500d53d9a1c83 -->

# Gamja Ops Infrastructure Registry Policy

This file is the central operations policy for Sanghyun's personal services.
It is maintained in the private `sanghyun-io/gamja-ops` repository and is
distributed to service repositories as `.ai/gamja-ops-policy.md`.

**Operational keys and values:** `opskv` is the official management source for
operational configuration and long-term credentials. Services still read `.env`;
those files are runtime delivery copies, not independent sources of truth.
The full management standard is included below in generated service copies.
Central source: `/Users/sanghyun/services/gamja-ops/policies/key-value-management.md`.
CLI guide: `/Users/sanghyun/services/gamja-ops/runbooks/opskv-operations.md`.

**Company-wide CI/CD:** GitHub Actions orchestration executed on Mac mini
self-hosted runners (macOS ARM64) is the default and normal path for every
GamjaWorld product, including new ones and repositories not yet registered in
`targets/service-repos.yaml` (that list is a delivery list, not a scope limit).
Jobs route by product+environment labels, but labels are a routing condition,
not a security boundary: the real boundary is repository registration/access
plus OS runtime isolation. GitHub-hosted runners are not a convenience
fallback; only unavoidable native targets (e.g. Windows builds) qualify for
exceptions, and each requires prior explicit Owner approval with recorded
reason, scope, owner, and expiry or review point. The Mac mini is the CI
execution host, distinct from OCI and Cloudflare runtime targets. The full
policy is included below in generated service copies. Central source:
`/Users/sanghyun/services/gamja-ops/policies/ci-cd-github-actions-macmini-runner-policy.md`.
Dated migration inventory:
`/Users/sanghyun/services/gamja-ops/docs/ci-cd-runner-migration-inventory-2026-10-16.md`.

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
- CI/CD workflow runner targets (GitHub-hosted vs self-hosted), runner names,
  labels, or repository scope, and workflow trigger security boundaries
  (fork/`pull_request_target`/untrusted code access)

Do not update `gamja-ops` for purely internal code changes that do not affect
deployment, routing, data ownership, secrets, backups, or provider configuration.

## OCI Management Access

The routine OCI management path is direct SSH through Tailscale:

```bash
ssh gamja-oci
```

Tailscale transport may be a direct P2P path or a relay. Do not assert which one
is in effect when the state is unverified, and do not treat a relay as a
guaranteed firewall bypass. Do not print node authentication URLs, private state
files, or full Tailscale status JSON.

`ssh gamja-oci-bastion` is a break-glass path for when Tailscale is unavailable;
use it only to confirm existing settings and within the approved scope. Do not
open public TCP/22 as an alternative. Do not add Tailscale CGNAT addresses from
`100.64.0.0/10` to the Bastion client-CIDR allowlist: Bastion requires the
connecting client's actual public egress `/32`.

Connectivity does not authorize infrastructure mutations. Obtain the required
approval before changing OCI resources, network rules, services, or data. The
central procedure is the [OCI management access runbook](https://github.com/sanghyun-io/gamja-ops/blob/main/runbooks/oci-access.md).

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
| Key/value configuration | `policies/key-value-management.md`, `tools/opskv/` |
| CI/CD pipeline or runner policy | `policies/ci-cd-github-actions-macmini-runner-policy.md`, `runbooks/harudo-staging-self-hosted-deployment.md` |
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

If a secret is exposed, contain further disclosure and preserve non-secret source
metadata. Do not delete evidence or rotate/revoke credentials without the required
authorization. Agent-caused disclosure remains the agent's investigation and
reporting responsibility. See the central credential-incident rules.

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
`policies/agent-infra-registry-policy.md` and/or `policies/key-value-management.md`
in `gamja-ops`, then sync the policy. Do not treat the base commit as proof that
uncommitted policy text was published; check the body digest and source state.

---

# 감자월드 전사 CI/CD 단일 기준 — GitHub Actions + Mac Mini self-hosted runner

시행일: 2026-10-16. **모든 감자월드 제품(기존·신규)의 CI/CD 기본·정상 경로는
GitHub Actions 오케스트레이션 → Mac Mini self-hosted runner(macOS ARM64)다.
GitHub-hosted 러너는 편의를 위한 기본 경로가 될 수 없다.** 이 문서는 2026-10-16
정책 제정·로컬 전파 단계에서 작성되었고, 같은 날 `origin/main` 기반 원격 게시
변경 단위로 재구성되었다. main 병합 시 이 문서가 원격 게시된 중앙 원본이 된다.
어느 단계에서도 이 정책은 러너 등록·환경 변경·운영 승인·인프라 변경을 부여하지
않으며, 제품별 전환과 예외 승인은 개별 결정이다.

## 적용 범위와 주체 구분

- 적용 대상: 감자월드의 **모든 기존·신규 제품과 그 저장소**.
  `targets/service-repos.yaml`에 아직 등록되지 않은 저장소와 `gamja-ops` 자체도
  포함된다. targets 목록은 생성 정책 전달(delivery) 목록일 뿐 정책 적용 범위를
  제한하지 않는다. 신규 제품은 저장소 생성 시점부터 이 기준을 적용하고,
  미등록 제품은 inventory에 "미전파 — 등록 대상"으로 명시한다.
- Mac Mini는 **CI/CD 실행 주체(runner host)** 다. OCI·Cloudflare는 **runtime
  target**(서비스가 실제 구동되는 환경)이며 두 역할은 구분된다. runner가 Mac Mini
  라는 사실과 배포 대상이 OCI 라는 사실은 혼동하거나 서로 대체되지 않는다.
- 예외 승인 없이 GitHub-hosted Linux로 우회하는 것은 금지한다. "빠르다",
  "설정이 간단하다"는 사유는 예외가 아니다.

## 러너 경계(최소 요구)

- 기본 형태는 repository-scoped runner다. 제품별 runner는 `self-hosted`, `macOS`,
  `ARM64`에 더해 **제품+환경 단위 식별 label**을 요구한다(선례:
  `macmini-harudo-staging`, label `harudo-staging` —
  `runbooks/harudo-staging-self-hosted-deployment.md`).
- runner group 사용은 명시적으로 승인된 경우에만 허용하며, group 경계가
  제품·환경 범위를 대체한다고 주장하지 않는다. **label은 job 라우팅 조건일 뿐
  보안 격리 수단이 아니다.** 실제 경계는 repository-scoped 등록·접근 통제와
  OS 실행 격리이며, label 일치만으로 같은 호스트의 다른 제품 자원·자격증명으로
  대한 격리가 확보되었다고 주장하지 않는다.
- runner 등록·재등록·라벨 변경·scope 변경은 인프라 변경이며 해당 승인을 받고,
  기존 저장소 범위와 label 경계를 유지한다. 이 정책 문서 작성·동기화는 runner를
  설치·등록·변경하지 않는다.

## 네이티브 타깃 예외(Windows 등)

- Windows 등 macOS ARM64 runner로 수행할 수 없는 네이티브 빌드·테스트 타깃만
  GitHub-hosted 예외의 정당한 사유다. 예외는 Owner의 **사전 명시 승인**을 요구하고
  다음을 기록한다: 사유, 범위(저장소·job·환경), 담당, 만료일 또는 재검토 시점.
- 사전 승인 기록을 **확인하지 않은** 기존 hosted 사용(예: 2026-10-16 inventory
  기준 Harudo Windows hosted)은 **승인 근거 미확인** 상태다. 이번 정책 제정이 이를
  자동 승인하지 않으며, 기존 승인 기록 확인 또는 신규 Owner 승인으로 예외 절차를
  편입해야 한다. 다만 기존 진행 중인 작업을 이 정책만으로 무단 중지·삭제하지
  않으며, 중지 여부는 개별 결정이다.

## 기존 gamja-deployer·수동 배포 경로

- 기존 `gamja-deployer`와 수동 배포 경로는 **승인된 단계적 migration 대상 또는
  비상 절차**로만 보존한다. 제품별 전환은 개별 승인으로 순차 수행하고 일괄
  제거하지 않는다. migration 전 제품에서는 기존 경로가 유효한 정상 경로이며,
  이 정책의 제정을 실제 전환 완료로 주장하지 않는다.

## 최소 안전 기준

CI/CD 워크플로와 runner 사용 시 다음을 최소 기준으로 강제한다.

1. **Protected source / exact SHA**: 배포 job은 protected branch(또는 승인된
   태그)의 이벤트 SHA를 정확히 사용한다. 임의 ref·작업트리 드리프트 금지.
   (선례: Harudo runner는 검토된 `main` push 이후에만 실행, development
   worktree는 배포 대상 아님.)
2. **Trusted branch / environment approvals**: 승인(environment protection)이
   없는 job은 배포·시크릿 접근을 수행하지 않는다.
3. **Fork·비신뢰 코드 격리**: fork·issue·임의 user-content 워크플로가
   self-hosted runner나 self-hosted 시크릿에 접근하지 못한다. public 저장소의
   임의 PR이 self-hosted runner에서 자동 실행되는 것을 금지한다. 비신뢰 코드는
   disposable 격리 환경에서만 실행하거나, 리뷰 등 명시적 신뢰 승격 단계를 통과한
   뒤에만 self-hosted에 올리고 그 경우에도 시크릿 접근을 주지 않는다.
   `pull_request_target` 및 비신뢰 코드에 대한 runner·시크릿 노출을 금지한다.
4. **Minimum `GITHUB_TOKEN` permissions**: 저장소·job 단위로 최소 권한을 명시한다.
   필요 없는 write 권한을 기본으로 남기지 않는다.
5. **Runner scope와 실제 격리 경계**: 작업은 label + repository 등록 경계로
   라우팅한다. 단, label은 라우팅 조건이지 격리 수단이고, repo-scoped 등록이라
   해도 같은 호스트의 다른 제품 서비스·자격증명이 자동 격리되지 않는다. 실제
   경계는 repository 등록·접근 통제와 OS 실행 격리·최소 권한이며, 한 제품의
   runner를 다른 제품이 승인 없이 재사용하지 않는다.
6. **Concurrency 직렬화**: GitHub `concurrency`는 같은 저장소 내에서만 직렬화하고
   저장소 간·공유 호스트 단위를 직렬화하지 못한다. 저장소 내 동일 대상 배포는
   `concurrency` group으로 직렬화하고, 여러 제품이 공유 Mac Mini 자원이나 공용
   대상을 침범하지 않으려면 호스트/대상 단위 공용 락 또는 검증된 중앙 큐 등
   저장소 간 직렬화 수단을 별도 구현·검증해야 한다. 현재 그런 수단이
   존재한다고 주장하지 않는다.
7. **Action pin과 신뢰 의존성**: third-party action은 태그가 아니라 commit SHA로
   pin하고, 릴리스 이력을 확인한 신뢰 가능한 출처만 사용한다.
8. **Artifact 추적성**: 빌드 산출물과 배포 대상의 exact SHA·digest 대응을
   기록·검증한다. 빌드되지 않은 코드의 배포, 또는 다른 attempt 산출물의
   대체 사용을 금지한다.
9. **Secret 로그 금지**: 비밀 값은 job 로그·artifact·argv에 남기지 않는다.
   마스킹 전에 비밀이 아닌 출처 메타데이터만 보존하는 기준은 홈 공통 지침의
   자격 증명 사고 규칙을 따른다.
10. **GitHub secrets은 opskv 전달본**: 운영 키·설정의 공식 관리 기준은
    `opskv`다(`policies/key-value-management.md`). GitHub repository/environment
    secrets은 실행용 전달본이며, registry·문서에는 이름·버전·출처(provenance)
    등 메타데이터만 기록하고 값은 남기지 않는다. `.env`와 마찬가지로 GitHub
    secrets을 독립 관리 원본으로 변경하여 운영 키 기준을 대체하지 못하게 한다.
     2026-10-16 inventory 문구는 당시 중앙 정책의 remote-publication 상태를
      기록한 역사 항목이다. 2026-10-21 현재 준비 중인 source update는
     `/Users/sanghyun/services/gamja-ops/policies/key-value-management.md`의
     정식 원문을 `policies/key-value-management.md`로 byte-identical하게 포함하고
     생성 bundle의 기존 정책 목록에 추가한다. 이는 OpsKV 값을 변경하지 않고,
     어떤 제품 저장소 사본도 이미 동기화되었다고 주장하지 않는다. 현재 게시·전파
     상태는 `docs/cicd-rollout-20261021.md`에서 확인한다.
11. **Runner identity/bootstrap 예외**: 기존에 근거가 기록된 runner 전용
    신원·부트스트랩 예외(예: Harudo staging synthetic owner credential의
    Keychain/opskv 이중 출처)는 그 근거 그대로만 보존한다. 이 항목은 새 예외의
    포괄적 생성 허가가 아니다. 각 새 예외는 개별 근거·승인·기록을 요구한다.

## 공통 내부 CLI·contract·artifact 보관 경계

### 도구 범위와 설정 소유권

- 공통 독립 운영 도구는 `opskv`(기존 전달 기능의 canonical command는
  `opskv deliver`)와 private 검증 배포본 보관용 `artifact-store`다. 제품 전용 CLI와
  서비스 내부 스크립트는 각 제품 경계에 남긴다. 새 앱·CI integration이 공통 도구에
  포함된다고 추정하지 않는다.
- 운영 설정·장기 자격증명의 SSOT는 `opskv`; `.env`/GitHub secrets는 승인된
  runtime 전달본이며 원본 역할을 대신하지 않는다. 비밀은 보호된 경로와 승인된
  scoped execution identity로만 다루며, 다른 UID runner로 복사하거나 broad
  human-wide authorization을 추가하지 않는다. key rotation, credential issuance,
  production config/DB write에는 기존 명시 승인이 그대로 적용된다. 상세는
  [`policies/key-value-management.md`](key-value-management.md)를 따른다.

### Service contract와 phase boundary

- 각 CI job은 canonical service ID, 기존 `/<service>/ci/PIPELINE_CONTRACT`, 실제
  등록 runner identity/contract, 기존 `artifact-store` service target binding을 쓴다.
  Service activation와 managed-setting readiness는 contract/inventory에서 서비스별로
  확인하고 일부 cohort의 상태를 전체에 일반화하지 않는다. Contract에 provider/root를
  복제하거나 workflow에서 hardcode/override하지 않는다. Target provider는 승인된
  config와 서비스별 보관정책이 결정한다. Archive key는
  `<service>/<environment>/<deployment-id>/<filename>`로 추적한다.
- Preflight는 고정 CI contract와 local service-target binding만 검사하며
  deployment/health/identity evidence가 아니다. 기존 mandatory deployment,
  health/identity gates를 약화하지 않는다. Preflight는 mutation 전에 실행할 수 있고,
  production archive는 기존 게이트 성공 뒤 검증된 exact production files에만
  적용한다. `--verified-deployment`는 caller assertion이다.

### Archive 보존과 product authority

- Archive source는 검증된 production gate 뒤에 승인된 exact files만 사용한다.
  Directory glob, secret/state paths, unverified local build 또는 임의
  provider/root override를 허용하지 않는다.
- Archive failure는 별도 경고/receipt로 기록하고 production deploy를 자동 retry·
  rollback하지 않는다. Same-run spool은 transient handoff이지 durable backup이 아니다.
  Immutable release audit, 현재/직전 rollback artifact, DB backup은 quota 해소를
  위한 cache cleanup 대상으로 취급하지 않는다. 기존 승인된 migration 전에는
  artifact를 다른 provider/root로 자동 이동·재생성·삭제하지 않는다. 제품별
  deployment controller와 CAS/target authority가 계속 권한 원본이며, 공통 CLI hook이
  이를 대체·우회하지 않는다. Retired `gamja-deployer` path를 기본값으로 되살리지
  않으며 복구는 별도 Owner 승인과 scoped recovery task에서만 한다.

### Readiness와 provenance

- Source commit, generated policy copy, local test, remote CI, deployment/health,
  archive upload/readback은 서로 다른 상태다. Contract 등록 또는 preflight 성공을
  `.env` reconciliation, archive, deployment, 전사 readiness 완료로 승격하지 않는다.
- 현행 상태는 dated ledger
  [`docs/cicd-rollout-20261021.md`](../docs/cicd-rollout-20261021.md)에서 확인한다.
  이 섹션은 불변 원칙만 보유하며 cohort별 현재 상태를 policy에 고정하지 않는다.

## 배포 게이트와 승인 경계

- self-hosted runner에서 실행되는 배포 job이라도 백업 존재 확인, 롤백 경로
  준비, 배포 후 헬스 체크, release identity(커밋 SHA·릴리스 ID) 확인을 게이트로
  통과해야 한다. DB 마이그레이션은 별개의 명시적 승인을 요구하며 기존 승인
  경계를 확대하지 않는다: 프로덕션 DB 변경은 Owner 승인 경계를 유지하고, 그 외
  환경의 DB 변경은 해당 서비스의 기존 승인 경로를 따른다. forward-only 등 적용
  방식은 개별 근거로 확인한다.
- 이 정책은 새로운 인프라·프로덕션 승인을 부여하지 않는다. 홈 공통 지침과
  서비스별 승인 경계를 그대로 적용한다.

## 완료 상태의 분리

정책 제정 / 로컬 전파 / 원격 게시 / 러너 등록 / 실제 전환 / 검증은 별개 상태다.
각 상태만이 완료로 보고될 수 있다.

- 2026-10-16(1차 기록): 이 문서는 **정책 제정 + 로컬 전파(생성 정책 동기화)**
  단계였다. `gamja-ops`의 로컬 working tree/branch 작성이며, GitHub 원격 main
  게시, 제품 워크플로의 Actions 전환, 러너 신규 등록, 기존 hosted 사용의 제거는
  **수행하지 않았다.** 로컬 branch(`ops/harudo-push-http-v1-20260725`)의
  변경이 원격 적용이나 전사 실제 준수를 뜻하지 않는다.
- 2026-10-16(2차 기록, 게시 준비): 이 문서를 포함한 변경 단위를 현재
  `origin/main` 기반의 격리 worktree/branch로 재구성했다. 이 시점에도 원격
  게시는 미수행이며, PR 검토·병합이 완료된 시점에 **원격 게시** 상태가 된다.
  재구성 과정에서 로컬 branch 전용이던 `.github/workflows/` 경로는 제외했다 —
  그 워크플로들은 GitHub-hosted 실행 정의로 새 정책의 우회 금지에 어긋나는
  구형태이며 전환 목표형이 아니다. `origin/main`은 workflow 추가를 금지하고
  검증·동기화는 `scripts/local-automation.rb`(Mac mini local GitHub gate)가
  수행한다. 이 gate는 **검증된 전환이 승인되기 전까지의 과도기 경로**이며,
  gamja-ops도 모든 제품과 같이 Actions + Mac Mini runner 전환 대상이다.
  workflow 금지 규칙은 전환 전 임시 현행일 뿐 gamja-ops를 러너 기준에서
  면제하는 예외 승인(영구·임시 모두)이 아니다. 병합 전에는 어느
  문서·스크립트도 게시 완료로 주장하지 않는다.
- 제품별 준수 여부는 아래 inventory를 참고하되, inventory는 시점 기록이며
  현재 상태 보장이 아니다.

## 제품 상태 inventory(2026-10-16 시점 기록)

아래는 이 정책을 제정한 것과 같은 메인 세션에서 앞서 수행한 읽기 전용 확인
(`gh api` 등 조회와 문서 기록)의 결과이며, 이 문서 개정 시 새로운 실시간
재확인은 수행하지 않았다. 각 항목은 해당 시점 데이터로만 사용하고, 미확인
항목은 `unknown`으로 기록하며 추정하지 않는다. 상세·후속 절차는
`docs/ci-cd-runner-migration-inventory-2026-10-16.md`.

| 제품 | 2026-10-16 시점 CI/CD 경로 | 정책 관점 상태 |
| --- | --- | --- |
| Harudo | self-hosted runner online, Windows hosted 사용 | Mac runner 사용 확인 — 제품+환경 label·전체 정책 적합성 미검증. Windows 예외 **승인 근거 미확인**(이 정책이 자동 승인하지 않음) |
| Figuredeal | dedicated self-hosted runner online | Mac runner 사용 확인 — label·scope 적합성 미검증 |
| Jobfit | GitHub-hosted Ubuntu | hosted 우회 — 전환 대상 |
| Living Cost Manager | GitHub-hosted Ubuntu | hosted 우회 — 전환 대상 |
| Magic Potion / Flashlingo | deploy job self-hosted, repo runner 등록 0 | 상태 불일치 — runner 등록 확인 필요 |
| GamjaWorld | 워크플로 0 | CI/CD 미구축 |
| Markdown viewer | GitHub-hosted Ubuntu | hosted 우회 — 전환 대상. targets 미등록 — 등록 대상 |
| Tax preprocessor | 저장소 미확인 | `unknown` — 추정 금지 |
| gamja-ops 자체 | 원격 main 워크플로 없음(로컬 branch에만 존재) | 전환 대상 — local gate는 과도기 경로(예외 아님, 2차 기록 참조) |

## 검증·배포

- Service `.ai/gamja-ops-policy.md`는 primary registry policy와
  `DEFAULT_POLICY_EXTRA`의 CI/CD·disk·key/value 세 source를 같은 ordered bundle로
  생성한다. Generated file을 수동 편집하지 않으며, header의 source list/commit,
  worktree state와 policy-body SHA-256으로 provenance를 확인한다.
- **Source publication unit**은 네 policy source (`agent-infra-registry`, CI/CD,
  disk-capacity, key/value), `targets/service-repos.yaml`,
  `scripts/sync-agent-policy.rb`, `scripts/verify-assets.rb`,
  `scripts/local-automation.rb`의 `POLICY_PATHS`,
  `test/policy_sync_bundle_test.rb`, `test/policy_sync_api_pr_mock_test.rb`와 관련
  README/rollout 문서를 함께 유지한다. `DEFAULT_POLICY_EXTRA`의 append-only union
  gate와 required-file check는 fail-closed이며 policy source 누락을 optional skip하지
  않는다.
- 현재 `gamja-ops` main에는 GitHub Actions workflow가 없다. Policy change detection은
  `local-automation.rb`의 `POLICY_PATHS`가 담당한다. Local project sync는 approved
  targets의 `--mode local`을 사용하며, dry-run/preflight와 managed-file provenance를
  확인한 후에만 실제 write한다. Remote policy PR에는 official `--mode github-api-pr`
  만 허용한다. Legacy `--mode github-pr`는 temp clone과 `--force-with-lease`를
  사용하므로 금지한다.
- Remote policy PR은 한 repository씩 순차 처리하고 `.ai/gamja-ops-policy.md` 단일
  파일 diff, source commit/body hash, dirty target backup, CI/deployment trigger와
  capacity gate를 검토한다. Required review, unexpected production trigger, or
  resource-gate block이면 해당 repository에서 중단하고 보고하며 merge/approval
  우회를 하지 않는다.
- 미등록·untracked repository를 sync에서 조건부 제외하지 않는다. `--mode local`은
  local path가 없으면 preflight에서 실패하며 등록 대상은 inventory에 명시한다.
  Local propagation은 remote project sync를 실제 수행한 경우에만 완료로 보고한다.
- 검사: `ruby scripts/verify-assets.rb`, `ruby test/policy_sync_bundle_test.rb`,
  `ruby test/policy_sync_api_pr_mock_test.rb`,
  `ruby test/local_automation_policy_state_test.rb`; 실제 target write 전에는
  `ruby scripts/sync-agent-policy.rb --mode local --dry-run`으로 전체 target을
  preflight한다. Remote PR mode는 source publication과 명시 승인 후에만 호출한다.

중앙 원본: `/Users/sanghyun/services/gamja-ops/policies/ci-cd-github-actions-macmini-runner-policy.md`.
선례 런북: `/Users/sanghyun/services/gamja-ops/runbooks/harudo-staging-self-hosted-deployment.md`.

---

# 감자월드 전사 디스크 용량 관리 기준

시행일: 2026-10-16. 이 문서는 감자월드 모든 제품·모든 도구(로컬 개발 워크스테이션,
Mac Mini CI runner, 개발 스테이징 환경)와 OCI 등 원격 runtime target에 적용되는
중앙 정책 원본이다. 원격 대상에는 지침 적용만 하고 이 문서의 승인만으로 원격
설정·서비스를 변경하지 않는다. 프로덕션 인프라 변경·유료 저장소 증설은 기존
승인 경계를 그대로 따른다. 이 정책은 벤더 최소 요구사항이 아니라 감자월드가
스스로 지키는 보수적 운영 기준이다.

## 1. 작업 전 용량 확인 (write-heavy operations)

git clone, 의존성 설치, 브라우저/플레이라이트 설치, docker build, 백업 생성,
DB migration, 대용량 빌드처럼 용량을 크게 소모하는 작업은 시작 전에 다음을
확인한다.

1. 대상 파일시스템의 실제 여유 공간(`df` 기준). 가정하지 않고 측정한다.
2. 작업의 예상 피크 사용량(피크 = 다운로드 + 임시 + 산출물, 통상 1.2배 여력)과
   롤백·재시도를 위한 예약분.
3. 여유 공간이 예상 피크 + 예약분 + 이 정책의 하한(§2)을 넘는 경우에만 진행.
4. 재확인(precheck re-run): 모델 전환·새 프로필·재시도·병렬 증가로 상태가
   변하면 1–3을 다시 수행하고, 결합 피크가 여유를 넘으면 무거운 작업을
   직렬화한다(일괄 병행 금지 아님). 부족한 용량을 반복 기록하며 대기하는
   것으로 대응을 대체하지 않는다.

### 예상치·실측·정수 게이트 판정 구분 — 2026-10-21

- `예상 피크`는 근거와 가정을 기록한 계획치이며 서비스에서 관찰한 실측 피크와
  다르다. 서비스 실측이 없으면 미실측/추정이라고 기록하고 실제 사용량으로
  표시하지 않는다. `피크 × 1.2`는 계획 여유 계산이지 사용량 관측 결과가 아니다.
- 계획 기록은 작업·산정 근거, 추정/관측 피크, 1.2 배율, 롤백·재시도 reserve,
  정책 floor, `df` 경로와 관측 시각, 실행한 integer gate 입력·실제 출력을 나눠
  남긴다. 과거 `df`를 현재 free space로 재사용하지 않는다.
- `scripts/disk-capacity-check.sh --gate`의 `--plan-add-gib`와
  `--plan-reserve-gib`는 정수 GiB 입력이다. 예컨대 **2 GiB 추정과 1 GiB 계획 reserve**는
  서비스 실측치가 아니다. 연속 산술은
  `15 + 2×1.2 + 1 = 18.4 GiB`지만, `--plan-add-gib 2 --plan-reserve-gib 1`에서
  gate는 `ceil(2.4)=3`으로 계산하여 `15 + 3 + 1 = 19 GiB`를 요구한다. 18.4는
  실제 integer gate의 요구량·판정이 아니다.
- **512 MiB 추정**의 연속 산술 `15 + 0.5×1.2 + 1 = 16.6 GiB` 역시 수동
  계획치이며 integer gate 결과가 아니다. 0.5 GiB는 CLI에 입력할 수 없고,
  이를 1 GiB로 올려 입력하면 gate 요구량은 `15 + ceil(1.2) + 1 = 18 GiB`다.
  이 수치들은 서로 다른 계획/실행 표현이다.
- 수치 편의만으로 15 GiB floor, 1.2 배율, reserve 또는 다른 gate 기준을 낮추지
  않는다. 계산과 측정 또는 실제 gate 출력이 다르면 가정·근거를 나누어 기록한다.

회피 규칙:

- 같은 대상을 중복 다운로드·중복 clone하지 않는다. 병렬 작업은 worktree로
  작업 복제를 분리하고, 캐시 공유는 보안 경계(계정·프로젝트 격리)를 유지하는
  범위에서만 한다.
- 작업 단위는 소유한 tmp 디렉터리를 사용하고 종료 시 정리한다(finish per-task
  owned tmp cleanup; 성공·실패·취소 무관). 다른 작업의 tmp·lock을 건드리지
  않는다. 작업별 대용량 산출물은 경로·용도·예상 크기·종료 처분의 작은
  영수증(receipt)으로 기록하고, 위임 시 정리 예산·책임을 함께 전달하며
  종합하는 주체가 최종 회계 책임을 진다.
- 작은 텍스트 편집·소형 테스트처럼 용량 소모가 거의 없는 작업은 게이트 면제로
  기록만 남긴다. 게이트가 이런 작업을 false-block 하도록 만들지 않는다.
- 여유가 기준에 못 미치면 대기·보고만 하지 말고, AI Agent가 §4 기준으로 폐기
  가능하다고 판단한 항목을 먼저 정확히 정리한 뒤 `df`를 다시 확인한다. 보호 대상의
  임의 삭제나 하한 완화로 작업을 강행하지 않으며, 정리로 부족하면 범위 축소·대상
  변경·Owner 결정으로 전환한다.

## 2. 임계 기준 (하드 상수 + 런타임 override)

기준은 이 정책과 저장소 스크립트에 코드 리뷰된 운영 상수이며, 개별 실행은
플래그(`--min-free-gib` 등)와 명시 env(`DISK_GATE_MIN_FREE_GIB`,
`DISK_SMALL_WRITE_MAX_KIB`)로만 override하고 사유를 기록한다. disk threshold와
allowlist는 코드 상수이지 운영 자격증명이 아니므로 opskv 항목으로 만들지 않고
전파는 중앙 정책 번들(생성 사본)과 저장소 코드로만 한다. 어느 계층에서 이
기준을 조회·설정해야 하는지의 범위 근거만 남기고, "opskv에 키가 없으므로
미적용" 같은 조회 결과 기반 주장하지 않는다. opskv가 담당하는 운영 키·설정과
혼동하지 않는다.

256Gi급 APFS 컨테이너(약 245GiB)의 Mac 개발/runner 볼륨 기준 예:

- **warning**: free < max(30Gi, 컨테이너의 15%). 컨테이너가 크면 15% 기준이
  더 큼을 택한다(245GiB에서는 약 36Gi). 이 구간에서는 §1의 사전 확인을 반드시
  수행하고 신규 write-heavy 작업을 줄인다.
- **hard floor**: free < 15Gi. write-heavy 작업의 자동 게이트가 거부한다.
  `scripts/macmini-runner-bootstrap.sh`의 기본 disk gate(`DEFAULT_MIN_FREE_GIB=15`)와
  정합하는 동일 기준이다. 게이트를 낮춰야 하면 Owner 검토 후 명시적 플래그와
  사유 기록으로만 한다.
- **critical**: free < 5Gi. 무거운 쓰기를 중단하고 긴급 정리 검토에 들어간다.
  기존 실행 중인 서비스의 동작을 손상시키지 않는 읽기 점검·소형 cleanup만 허용.

볼륨 크기가 다르면 절대값(15Gi/5Gi)과 15% 중 작업에 더 엄격한 기준을 쓴다.
물리적으로 성립할 수 없는 목표(예: 256Gi 볼륨에 2Ti 예약)를 요구하지 않고,
동적 피크 추정과 정적 하한을 함께 쓴다. 하한 도달이 안전 cleanup만으로 불가능하면
§5의 에스컬레이션으로 넘어가고 임의 삭제로 하한을 채우지 않는다.

## 3. 주기 점검 (읽기 전용)과 정리 (삭제)를 분리

2026-10-20 Owner 지시(PR #192): 삭제는 AI Agent의 작업 전후 판단으로만 수행한다.
기존 무인 삭제 작업 `com.sanghyun.disk-janitor`는 중지·비활성화했으며 파일은 보존한다.

- **daily read check**: 여유 공간과 임계 수준을 읽어서 보고만 하는 점검.
  `scripts/disk-capacity-check.sh` report 모드가 도구이며, 스케줄링은
  `scripts/disk-capacity-report.sh`(LaunchAgent `top.gamja.disk-capacity-report`)로
  선택 사항이다. runner는 자기 0700 로그 디렉터리의 bounded 리포트 파일
  (latest.txt atomic replace + own-pattern rotate 최대 30개,
  untrusted-owner/symlink 디렉터리 거부)만 쓰고 어떤 캐시도 삭제하지 않는다.
  설치는 `scripts/install-disk-monitor.sh`: 검증된 runtime 스크립트 3개를
  hash 검증된 버전드 release(동일 uid 쓰기에 대한 불변 속성 보장 아님)
  (`~/.local/share/gamja-disk-monitor/releases/<source-hash>/`, 0700, 최대 2개,
  구 release 자동 삭제 금지, 초과 시 stop+report)로 복사하고 plist는
  `__RUNTIME_ROOT__` 바인딩으로 렌더한다(placeholder 집합 정확 검증,
  경로 charset·parent-symlink·owner strict, 기존 다른 내용 ABORT). 따라서
  review worktree를 지워도 설치된 job은 원본과 무관하게 동작한다. 기본
  `--dry-run`과 `--apply`는 실볼륨 small-metadata exception 게이트(§4)를
  통과해야 하고, `--plan-only`는 게이트 없는 순수 plan 검증 유닛이다.
  installer는 `launchctl`을 호출하지 않는다 — load는 별개의 명시적 operator
  단계다. 2026-10-17 현재 release `561c81106afadcce`가 설치·loaded되어
  daily 09:00 읽기 리포트와 월요일 report-only 후보 표를 생성한다(아래
  runbook LaunchAgent 상태). 설치·load가 없는 환경에서는 cron/launchd가
  도는 것처럼 보고하지 않는다.
- **weekly review**: 후보 목록의 report-only 갱신·검토. runner는 월요일(및 `--weekly`)
  에 후보 표를 리포트에 병합하고, 수동은 `sh scripts/disk-cache-cleanup.sh`(기본
  report)가 같은 표를 낸다. 주간 review·정리는 수동 필수 절차이며 unattended
  cache delete를 주장하지 않는다.
- 실제 삭제는 §4의 개별 절차로만 수행한다. 소스의 주기 자동화 코드(runner
  포함)는 report 전용이고, auto-delete 경로는 어떤 스케줄에도 연결하지 않는다.
  스케줄 설치 시에도 daily=읽기 리포트, weekly(월요일)=report-only 후보 표일
  뿐이며 unattended cache delete는 존재하지 않는다.

## 4. 안전 정리 범위 — 전사 일괄 삭제 도구 없음, 개별 reviewed plan만

review(round 3, 2026-10-17) 확정: `scripts/disk-cache-cleanup.sh`는
**report 전용 인벤토리**다. `--apply`·`--entry`·`--go-bin`·
`--confirm-external-quiescence` 등 apply 경로 플래그는 폐지되고 항상 명시
거부되며, 어떤 캐시 삭제도 수행하지 않는다. 이전 go 전용 apply 경로에 남은
3가지 잔여 리스크(go tool의 GOENV/GOCACHE env bypass, 부모 symlink 창,
lsof fail-open 모호성)는 apply 경로 자체를 삭제해 해소했다. 도구 내에서
`go env`/`go clean` 등 공식 바이너리를 일절 호출하지 않는다(호출 자체가
toolchain download·상태 변경 위험). 후보 행은 `du -sk`/`stat` 읽기
메타데이터와 프로세스 주석만 인쇄한다. 프로세스 주석은 PRIVACY FIX
(2026-10-17): `pgrep -f`는 내부 PID 매칭에만 쓰고 주석에는 `ps -o comm=`
basename + PID만 기록한다(최대 4개 + 총합 토큰, 안전 charset, 소멸 프로세스는
고정 토큰 `gone`). 명령 인자(argv)는 절대 기록하지 않는다 — argv는
자격증명을 담을 수 있으며 `pgrep -fl` 생-string 기록은 폐지됐다.

개별 삭제의 정규 절차:

1. 주간 review의 후보표 갱신·검토는 complementary audit이며, own task
   cleanup의 사전 요건이나 연기 사유가 아니다.
2. 격리된 own tmp/worktree 산출물은 **작업 종료 근거(documented
   evidence)**와 **exact reviewed plan(정확한 경로 목록)**이 있으면 항목별로
   개별 삭제한다. own task cleanup은 **작업 종료 시점에 즉시** 수행하고
   주 1회 review를 기다리지 않으며, 성공·실패·취소 모두에 정리 완료 또는
   구체적 차단 사유 회계를 남긴다. 증거 분류: 재현 불가능한 고유 증거·
   보안 근거는 보존하고, 소스·잠금 파일·빌드 방법이나 Release 동일
   크기·해시 원본으로 재구성 가능한 산출물은 정리 대상이다. 예:
   2026-10-17 flashlingo owned node_modules 2개 exact 경로는 main이
   reviewed plan으로 삭제 완료(df delta 실측 기록).
3. 대량·전역 clean이 실제로 필요하면 별도 work item으로, 공식 도구의
   효과 범위를 검토한 뒤 용량 리뷰와 명시 승인을 받아 수행한다. 이 정책의
   자동화나 전사 도구는 그 역할을 하지 않는다.
4. 삭제는 AI Agent가 작업 전후 정리 과정에서 직접 판단해 수행한다. LaunchAgent·
   cron·타이머처럼 판단 없이 스케줄로 도는 무인 자동 삭제는 두지 않는다. 폐기 판단이
   선 항목은 그 작업에서 정확한 경로·ID로 즉시 정리하며 Docker 자원도 일괄 보존하지 않는다.
   - Docker 보존 대상: 실행·정지 컨테이너가 참조하는 이미지·볼륨, 제품별 현재 운영본과
     직전 롤백본, 고유 업무 데이터일 수 있는 볼륨. 확인되지 않은 데이터는 보존·보고한다.
   - Docker 폐기 대상: 참조·사용 여부와 출처를 확인한 이전 릴리스·후보·dangling 이미지,
     익명·CI·테스트용 볼륨, 미사용 빌드 캐시. 정확한 ID로 개별 정리한다.
   - 전역 prune(`docker system prune`, `image prune -a`, `volume prune`)는 금지한다.
     Colima VM 디스크 파일 삭제·VM 재생성은 별도 승인 대상이다. guest `fstrim`의
     실제 회수 여부는 호스트 `df`로 확인하며, 공칭 회수량과 혼동하지 않는다.
   그 외 삭제 금지(보존) 목록: DB 백업·포렌식/logs 증거, `.env`·keys·opskv 참조·
   credentials, 서비스 캐시와 업무 데이터, dirty/untracked git worktree(예외: 그 안에서 own 작업이 생성한
   ignored ∧ 재생가능 아티팩트는 `git ls-files`·`git check-ignore`로 추적·
   ignore 상태 확인 + 활성 프로세스 없음 + 출처 근거 후 개별 정확 삭제만
   가능. worktree 전체 삭제 금지, ignored라는 이유만으로의 광범위 삭제
   금지, 확인되지 않은 것은 모두 보존 fail-closed), 활성 runner와 그 `_work`, 사용자
   세션이 살아 있는 브라우저 캐시·프로필, 타 프로젝트가 진행 중인
   node_modules·활성 playwright 브라우저 캐시. 병렬 작업과 경합하는 package
   cache는 mtime 보존 창으로 두고 skip한다. 캐시라는 이름만으로 재생가능을
   단정하지 않는다. 이 문구는 폐기 판단된 Docker 자원을 다시 일괄 보존하라는 뜻이 아니다.
5. 회수량은 `df` delta로만 검증하고 병행 세션의 자연 증가·감소와 구분
   주장하지 않는다. 종료 보고에는 삭제 항목·보존 사유·before/after `df`·
   잔존 대형 항목을 작은 기록으로 남긴다. `du`는 공유 hardlink를 셀 수 있고
   APFS snapshot은 계산이 달라 물리 사용량과 늘 일치한다고 주장하지 않는다.

소형 설치 예외(게이트 인하 아님): LaunchAgent 모니터 설치는 §2의 절대
threshold를 낮추지 않고, 스크립트+plist 실측 + 리포트 예산 ≤2MiB이고
`free − 필요 − 1GiB 롤백 reserve ≥ 0`일 때만 허용되는 문서화된
small-metadata exception이다(현재 critical 5Gi 미만 구간에서도 성립—그게
목적). 다른 installer에 자동 확장 금지; install-local-automation.sh는 자체
필요량+1Gi reserve 회계를 별도 유지한다. heavy 작업의 15Gi floor/5Gi
critical은 불변.

## 5. 정리로 하한을 채울 수 없을 때

cache/후보 cleanup으로 hard floor(15Gi)에 도달하지 못하면 부족분을 솔직하게
보고하고 Owner 판단으로 에스컬레이션한다: 대규모 소비자(colima/Docker VM,
서비스 저장소 worktree 정리, 에이전트 런타임 홈, 외부 저장소 증설 등)의 별도
승인 검토, 작업 범위 축소, 게이트 하향의 명시적 승인. 에이전트가 임의로 이
보존 목록을 정리하여 하한을 통과시키는 것은 허용하지 않는다. §4의 확인·승인 범위에서
AI Agent가 폐기 판단해 수행하는 정확한 정리는 여기서 말하는 '임의' 삭제가 아니다.

---

# 감자월드 운영 Key&Value 관리 표준

시행일: 2026-10-07. **운영 설정과 장기 자격증명의 공식 관리 기준은 `opskv`이며,
서비스는 기존처럼 `.env`를 읽는다. `.env`는 실행용 전달본이지 별도 관리 원본이 아니다.**

## 적용 범위와 예외

- 서비스·인프라의 운영 설정, 외부 제공자 API 키, 장기 인증정보가 대상이다.
- 고객 업무 데이터·개인정보, 캐시, 일시 세션 토큰, 프로그램 내부 변수·상수는 대상이 아니다.
- 저장 경로는 `/service/environment/key`이다. 환경은 확인 후 `production`,
  `staging`, `shared` 등으로 구분하며, 미확인 값을 임의로 운영용으로 추정하지 않는다.
- 순환 의존을 피하기 위해 마스터키·복구 키와 `opskv` 자체 접속에 필요한 SSH/DB
  인증정보는 외부 보관 예외다. 서버의 접근 제한 파일 또는 기존 OS 인증 저장소를
  사용하고 목적·소유자·저장 위치만 기록한다. 실제 값은 Git·문서에 넣지 않는다.
- 실제 보관 위치는 `/opt/gamja-opskv/secrets/`, `/opt/gamja-opskv/recovery/`,
  MacMini의 `~/.config/gamja-deployer/secrets/opskv-recovery/`이다. 파일 권한은
  `0600`, 비밀 디렉터리는 `0700`을 유지한다. 정상 도구의 OAuth 세션 저장도
  허용하되, 이를 일반 운영 키를 별도 관리하는 포괄적 예외로 사용하지 않는다.

## 정상 등록·변경 절차

1. 서비스·환경·키·제공자·용도·원본 참조를 확인한다. 값은 채팅·로그·명령 인자에 출력하지 않는다.
2. `opskv list`, `show`, `history`로 존재 여부와 현재 버전을 확인한다.
3. 보호된 파일 또는 표준입력으로 `opskv set`을 실행한다. 신규 등록은
   `--expected-version 0`, 변경은 확인한 현재 버전을 사용한다.
4. 실행에 필요한 검증된 값만 `.env`에 전달한다. 현재는 자동 export·배포 동기화가
   구현되지 않았으므로 승인된 작업에서 최소한의 수동 전달만 한다. `opskv get
   --output`은 새 `0600` 파일을 만들며, 터미널에 비밀 값을 출력하지 않는다.
5. 운영 적용 전 기존 `.env` 백업, 대상·영향·승인 범위·롤백을 확인한다.
   필요한 재배포/재시작과 상태 확인은 기존 승인 절차를 따른다. 이 정책은 추가 운영 승인이 아니다.
6. 기준 버전·반영 여부·검증 결과를 값이 아닌 메타데이터로 기록한다.

`.env`에서 먼저 값을 바꾸고 그 파일을 새로운 기준으로 삼는 방식은 금지한다.
정상적인 `opskv` → `.env` 전달은 허용하며, 금지 대상은 독립적인 원본 변경이다.

## 기존 항목의 전환과 불일치 처리

- 기존 관리 자료에서 이관한 114개 항목은 현재 `unverified` / `needs_review`다.
  정책의 기준 지정과 모든 기존 값의 정확성 검증은 별개다.
- 이전 로컬 비교에서는 동일 이름 29개 항목 중 27개 일치, 2개 불일치였으며
  최신 원본은 미확인이다. 그 값을 서비스에 자동 적용하지 않는다.
- 불일치를 발견하면 현재 정상 `.env`를 유지하고 제공자·환경·소유자·발급/회전
  이력과 원본을 확인한다. 어느 쪽도 자동 승자로 정하지 않는다. 확인된 값을
  `opskv`에 기록하고 승인 범위 안에서 전달본을 맞춘다.
- 전환은 서비스별로 수행하고 항목·환경·기준 버전·반영 결과·미확인 사항을 남긴다.
  경로 승격·환경 재분류 도구는 아직 없으므로 존재하지 않는 `promote` 등을 가정하지 않는다.
- 신규·변경 항목에는 이 원칙을 즉시 적용한다. 기존 미검증 항목의 실행 경로는
  검증 후 전환하며, 현재 모든 서비스가 중앙 저장소와 동기화됐다고 주장하지 않는다.

## 과거 기록의 보존 규칙

기존 이관 근거·과거 기록·전달본·백업은 보존하되 별도 관리 원본이나 자동
fallback으로 사용하지 않는다. 에이전트는 운영 키·설정 작업 전에 `opskv list`,
`show`, `history`로 관리 경로·상태·버전을 확인한다. 과거 보관본을 일상적인
조회·등록·변경 대상으로 재탐색하거나 편집하지 않는다.

`opskv diff`는 대조만 한다. 예외적인 추가 이관은 별도 요청의 대상·출처·충돌을
검토한 뒤 수행하며, 기존 보관본을 기준으로 일상적인 동기화를 하지 않는다.

## 장애·긴급 변경·키 회전

- `opskv` 장애 시 기존 정상 `.env`로 서비스를 유지한다. 오래된 파일을
  새 기준으로 승격하거나 미확인 값을 적용하지 않는다.
- 불가피한 긴급 `.env` 직접 변경은 필요한 Owner 승인 후 수행한다. 대상·이유·
  승인·백업·롤백·수행자·시각·기준 버전을 비밀 없이 기록하고 서비스 상태를 확인한다.
  복구 후 `opskv`에 재조정하여 변경 이력과 전달본을 일치시킨다.
- 제공자에서 키를 발급·회전·폐기하는 것과 `opskv`의 값을 변경하는 것은 별개다.
  제공자 조치는 해당 승인·검토를 거친다. 승인된 새 값은 `set`으로 기록하고
  전달·검증한 뒤 구 키 처리를 확인한다. 단순 DB 수정은 키 회전을 뜻하지 않는다.
- 이번 노출 건의 회전은 사용자가 직접 수행한다고 했지만, 이것이 일반적인
  책임 전가 규칙은 아니다. 에이전트가 초래한 노출의 조사·보고 책임은 유지한다.
  폐기된 키를 `rollback`으로 운영에 다시 적용하지 않는다.

## 배포·검증 범위

- 로컬 전역·홈 `AGENTS.md`와 등록된 서비스의 생성 정책으로 핵심 규칙을 전달한다.
- 생성 정책은 `scripts/sync-agent-policy.rb --mode local`로 배포하며 수동 수정하지 않는다.
- 생성 헤더에는 기준 커밋, 실제 배포 본문의 SHA-256, 작업트리 상태를 기록한다.
  이는 비밀이 아닌 정책 본문의 출처 확인이며 자격증명 해시를 남기는 방식이 아니다.
- 로컬 반영은 GitHub·외부 에이전트·다른 머신의 자동 적용이나 기술적 강제를 의미하지 않는다.
- 검사: `ruby scripts/verify-assets.rb`, 정책 동기화 검사, 공통 AGENTS 섹션 동일성 확인.

중앙 원본: `/Users/sanghyun/services/gamja-ops/policies/key-value-management.md`.
사용 방법: `/Users/sanghyun/services/gamja-ops/runbooks/opskv-operations.md`.
