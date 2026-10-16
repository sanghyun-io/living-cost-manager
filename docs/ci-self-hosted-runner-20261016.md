# Living Cost Manager — CI/CD self-hosted runner 전환 (2026-10-16)

Owner 승인(qa): "기존 Mac Mini에 별도 실행계정으로 분리한 LCM 저장소·운영 환경
전용 러너를 등록하고 CI와 FE배포 GitHub Actions 전환" → **전용 러너 전환 승인**.
본 문서는 그 승인의 LCM 범위 실행 기록과 Main·Owner 후속 단계 인터페이스를 담는다.
전사 기준은 `sanghyun-io/gamja-ops`
`policies/ci-cd-github-actions-macmini-runner-policy.md`(시행 2026-10-16)이며,
**이 전환은 LCM 저장소만 수행한다 — 다른 제품이 마이그레이션된 것이 아니다.**

## 1. 실행 상태 요약 (2026-10-16 시점, live 확인 근거 포함)

| 항목 | 상태 |
| --- | --- |
| CI 워크플로·harness·runner 설치 키트 | `feat/ci-runner-a98c952d` 브랜치 로컬 커밋 완료 (base `d4baef50b6f42dbf68c032ab5a7a31c4aeef8653`) |
| 레거시 GitHub-hosted `api-tests.yml` | 브랜치에서 삭제 (배포·공개는 Main 결정, 아직 원격 main은 레거시 유지) |
| GitHub Actions 실행 | **수행 안 함** — 워크플로 미공개, runner 미등록. 어떤 Actions run도 완료 주장하지 않음 |
| runner 등록 | 차단됨: macOS 사용자 생성·LaunchDaemon 설치는 sudo(Owner 비밀번호) 필요, `sudo -n` 실패 확인. owner uid로 대체하지 않는다 |
| `production` environment | 생성 완료: protection rule `required_reviewers` = sanghyun-io (API로 실측 확인, wait_timer 없음, deployment_branch_policy 없음) |
| main 브랜치 보호 | 현재 미설정(404 실측). 전환 공개 시점에 Owner가 별도 적용 — 아래 §5 |
| 시크릿 provisioning | 의도적으로 미 수행 — runner도 없고 레거시 운영자 배포 경로는 유지되므로 노출 창만 늘린다. 절차는 §6 |
| 로컬 harness 검증 | 임시 Postgres 기동/stop 멱등 + 빌드·shared/web/api·marketing·typecheck 전부 통과 — §7 |

runner tarball 본인증: actions/runner **v2.338.0** osx-arm64
`df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2` = 공식
GitHub Release 본문의 SHA-256과 다운로드 실측 일치(2026-10-16).
token/argv 검증: 업스트릿 `src/Runner.Listener/CommandSettings.cs`(v2.338.0)가
`ACTIONS_RUNNER_INPUT_*` 환경변수를 읽고 secret masking 후 env에서 삭제함을
실소스로 확인 — 등록 토큰은 argv 없이 stdin/env로만 전달(02/05 스크립트).

## 2. 워크플로 인터페이스

- `.github/workflows/ci.yml` — 트리거 `push: [main]` + `workflow_dispatch`.
  `permissions: contents: read`, checkout `persist-credentials: false`.
  pull_request/fork/이슈 콘텐츠 경로 없음(비신뢰 코드 self-hosted 실행 금지 준수).
  PR에 자동 테스트가 없어지는 것은 정책상 의도된 동작이다(검증된 main push·dispatch만 self-hosted).
- `.github/workflows/deploy-pages.yml` — **workflow_dispatch 전용**(push 자동
  FE 배포 폐지 상태 유지). job gate: `github.repository ==
  'sanghyun-io/living-cost-manager' && github.ref == 'refs/heads/main'` +
  environment `production`(required reviewers 통과 없이는 시크릿·배포 불가).
  exact `GITHUB_SHA`로 빌드·`write-release-meta.mjs`·deploy하고 양 Origin의
  `release-meta.json` 실대조 후 index 200 확인. 백엔드 OCI 전환은 범위 밖(운영자 승인 경로 유지).
  배포 도구는 npx `wrangler@4.131.1`(2026-10-03 릴리스 근거와 동일 pin) —
  **루트/앱 package.json을 수정하지 않는다**(manifest 변경 계약 위반 회피).
- Action pin(공식 GitHub actions만, third-party 금지):
  `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1, release 2026-07-20),
  `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1` (v7.1.0, release 2026-10-08).
  tag→commit은 `git/matching-refs` API로 실확인. Node `24.18.0` exact, pnpm은
  corepack + 루트 `packageManager: pnpm@11.1.3`(서드파티 setup action 없음).
  Actions cache 미사용(Free 캐시 한도·재현성).
- 러너 라벨 `self-hosted, macOS, ARM64, lcm-production` — **라우팅 조건일 뿐
  격리 수단 아님**. 실제 경계: repository-scoped 등록 + 비관리자 OS 계정.

## 3. CI test harness (scripts/ci/)

- `ephemeral-postgres.mjs` — CI 전용 임시 PostgreSQL 16 클러스터. Homebrew
  `/opt/homebrew/opt/postgresql@16/bin`(world-readable)만 사용, 데이터/상태는
  CI 계정 전용 0700 state dir(`$HOME/lcm-ci-test-pg` 기본), `initdb -A trust` +
  `listen_addresses=127.0.0.1` + 127.0.0.1 전용 포트 스캔(54500–54559). DB=role=
  schema 이름 전부 `lcm_ci_test` — `apps/api/tests/test-database.ts`의
  test-isolation guard를 통과하는 형태만 허용. 상태 파일에 기록된 자기 uid/PID/
  dataDir가 아니면 **어떤 프로세스·디렉터리도 종료·삭제하지 않는다**(kill 대상
  검증: 기록된 postmaster pid만). 5432 개발 클래스터·SSH 터널(5433/55432)·OCI/
  프로덕션 DB와 무관. `fsync=off`(ephemeral 전용). stop은 멱등 cleanup과 data dir 제거.
- `host-lock.mjs` — LCM-scoped 호스트 advisory lock(state dir 안 0700 경로).
  같은 uid의 죽은 PID 잔여 락만 회수; 타 uid 락은 실패 보고. GitHub `concurrency`는
  저장소 내 직렬화이고 이 락도 LCM CI job 간 공유 자원 직렬화용 — **다른 저장소·
  제품까지 직렬화하지 못하며(중앙 큐 존재하지 않음) host 단위 전역 보장을 주장하지 않는다.**
- `run-workspace-vitest.mjs` — `vitest run --maxWorkers=2` 래퍼(공유 호스트 배려;
  앱 스크립트·manifest 수정 없음).
- 웹 테스트는 vitest+jsdom 단위 계열(GUI·브라우저 바이너리 불필요), API는 위 임시
  클러스터, 그 외 marketing은 `pnpm test:marketing`(node --test glob).
  `verify:pricing`·`public-smoke`(pwsh)·브라우저 스크립트는 Playwright browser
  바이너리/운영자 환경 의존이라 CI에서 제외하고 운영자 로컬 검증으로 유지한다.
  (2026-10-16 실측: `node --test <dir>` 형태는 실패, `pnpm test:marketing` glob
  형태 통과 — 워크플로는 후자 사용.)

## 4. runner 설치 키트 (scripts/ci/runner/) — Owner 1회 절차

`README.md` 절차 그대로: `sudo 01-create-account.sh`(비관리자 `lcm-ci`: admin
그룹·sudo·패스워드·interactive login 없음, 홈 0700) → registration token을
stdin 파이프만으로 `sudo -u lcm-ci 02-install-runner.sh`(pinned tarball sha256
검증 후 저장소 전용 등록, 기존 동일 identity 있으면 거부) → `sudo
03-install-launchd.sh`(root 0644 plist, lcm-ci 실행, 최소 PATH, 로그 0700) →
`04-verify.sh` 읽기 전용 확인. 05-remove.sh는 LCM runner만 해제(계정·파일·타
제품 러너 보존). **Harudo/Figuredeal Runner.Listener 수정·중지·재사용 없음,
runner group 없음, 기존 deploy SSH 키·OCI ssh를 CI가 사용하지 않음(FE-only
Cloudflare), owner의 ~/.ssh·~/.config·Keychain을 lcm-ci가 읽지 못함(홈 권한 경계).**

## 5. 게이트 실제 상태와 남은 Owner 결정

- `production` environment required_reviewers: **실제 생성·확인됨**(API 실측).
  solo-owner이므로 self-review 허용(prevent_self_review=false) — 승인은 결국
  Owner의 수동 클릭이며 자동 승인하지 않는다.
- deployment branch policy 하위 엔드포인트는 이 저장소 API 표면에서 404
  (github-pages 자동 환경도 동일) → 환경측 branch 락 대신 워크플로 internal
  `refs/heads/main` exact guard를 게이트로 사용. 정책상 우회 아님, 기록됨.
- main branch protection(404=미설정)은 **전환 공개 단계에서 Owner 적용 권장**:
  지금 걸면 UX 통합 direct push 흐름(Main 진행 중)을 차단하므로 본 단계에서
  미적용. 워크플로가 원격 main에 게시·실행되기 시작하는 시점에는 (1) main
  protection(최소: PR required 또는 최소 승인 status) (2) 실제 Actions run
  검증 (3) secret provisioning 순서로 함께 결정한다.
- OS 계정: `sudo -n` 불가 → 실행 에이전트 차단. Owner의 1회 sudo(또는 동등한
  관리자 수행)이 유일한 봉(blocker). owner uid로 러너를 돌리는 우회 금지.

## 6. 시크릿 전달 절차 (runner 등록·워크플로 공개 이후 단계)

원본 기준은 opskv(전달본으로서 GitHub environment secrets). 2026-10-16 조회
메타데이터: `/shared/unverified/CLOUDFLARE_API_TOKEN`(secret, v1,
`needs_review`, gsheet row26), `/shared/unverified/CLOUDFLARE_ACCOUNT_ID`
(secret, v1, needs_review, row27). 2026-10-03 릴리스에서 실제 Pages 프로젝트
`living-cost-manager`에 유효 검증된 것과 같은 전용 토큰 계보이나 **opskv 상태는
needs_review 유지 — 전달 전 read-only 제공자 재확인**(wrangler whoami성 read
조회)을 수행한다.

```bash
opskv get /shared/unverified/CLOUDFLARE_API_TOKEN --output ~/lcm-ci-secrets/cf_token      # 새 0600 파일
gh secret set CLOUDFLARE_API_TOKEN --env production < ~/lcm-ci-secrets/cf_token           # stdin만, --body 사용 금지
gh secret set CLOUDFLARE_ACCOUNT_ID --env production < ~/lcm-ci-secrets/cf_account_id
```

값은 argv·stdout·로그·artifact·Git에 남기지 않고, 미검증 global 키를 승인 없이
운영으로 승격하지 않으며, opskv의 needs_review 메타데이터를 임의 갱신하지 않는다.
 테스트 job(ci.yml)은 어떤 시크릿도 요구하지 않는다.

## 7. 로컬 검증 결과 (2026-10-16, CI harness와 동일 명령 경로)

임시 클러스터: initdb+pg_ctl 성공, 127.0.0.1:54500, URL
`postgresql://lcm_ci_test@127.0.0.1:54500/lcm_ci_test?schema=lcm_ci_test`
(guard 통과 형태), 홈/데이터/state 0700/0700/0600 권한 실측, stop 멱등 확인,
stop 후 포트 해제·data dir 제거 확인. 워크플로 YAML 2종 파싱 OK(js-yaml).

- `pnpm install --frozen-lockfile`(corepack pnpm 11.1.3)·`db:generate`·
  `pnpm -r --if-present build` 성공(Next static export, guide SG 포함).
- shared: **197 passed** / web: **664 passed, 1 skipped**(jsdom) —
  `run-workspace-vitest.mjs --maxWorkers=2` 적용.
- api: **30 test files / 461 passed** — 임시 클러스터에 `prisma migrate reset`
  후 실행. 코치 워커 esbuild 산출물 6,611,249 bytes(≈6.6MB, 빌드 근거 일치).
- marketing(`pnpm test:marketing`)·web typecheck 통과. `verify:pricing`은
  Playwright 의존으로 CI 제외 결정(§3).
- 이는 **로컬 harness 검증**이며 GitHub Actions run 완료 주장이 아니다(runner
  미등록·워크플로 미공개). Actions 실run 검증은 §8 순서 완료 후 Main이 수행한다.

## 8. 공개(메인 머지)와 롤백

- 공개: Main 리뷰 후 이 브랜치를 머지하면 ci.yml/deploy-pages.yml가 원격 main에
  게시된다. 게시와 동시에 runner가 없으면 push CI가 queue에 대기만 한다(실패
  아님). **runner 등록(§4) 완료 후에 머지하는 것을 권장 순서로 한다.**
- 롤백: 워크플로 파일 revert( git history 보존) + `05-remove.sh`(LCM runner만
  해제). 레거시 hosted 워크플로는 자동 복원하지 않으며 기존 운영자 Wrangler/OCI
  배포 경로는 그대로 유효하다(전환 완료까지 정상 경로).
- 사용자 payment PG 플래그 등 앱 상태와 UX worktree(`/Users/sanghyun/services/lcm-ux-polish-20261016-a98c952d`)
  파일은 본 작업에서 읽지도 수정하지도 않았다. gamja-ops 인벤토리·정책 원본도
  수정하지 않았다(레지스트리 갱신은 Main 후속 단계).
