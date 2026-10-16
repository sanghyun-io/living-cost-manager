# Living Cost Manager — CI/CD self-hosted runner 전환 (2026-10-16)

Owner 승인(qa): "기존 Mac Mini에 별도 실행계정으로 분리한 LCM 저장소·운영 환경
전용 러너를 등록하고 CI와 FE배포 GitHub Actions 전환" → **전용 러너 전환 승인**.
본 문서는 그 승인의 LCM 범위 실행 기록과 Main·Owner 후속 단계 인터페이스를 담는다.
전사 기준은 `sanghyun-io/gamja-ops`
`policies/ci-cd-github-actions-macmini-runner-policy.md`(시행 2026-10-16)이며,
**이 전환은 LCM 저장소만 수행한다 — 다른 제품이 마이그레이션된 것이 아니다.**

## 1. 실행 상태 요약 (2026-10-16 시점, 보안 수정 완료)

| 항목 | 상태 |
| --- | --- |
| CI 워크플로·harness·runner 설치 키트 | `feat/ci-runner-a98c952d` 브랜치 로컬 커밋 완료 |
| **P1 보안 수정 7건** | **모두 해결** (root symlink, PG trust, CI guards, protected source, CI-success-gate, token handling, npx deps) |
| 레거시 GitHub-hosted `api-tests.yml` | 브랜치에서 삭제 |
| GitHub Actions 실행 | **수행 안 함** — 워크플로 미공개, runner 미등록 |
| runner 등록 | 차단됨: macOS 사용자 생성·LaunchDaemon 설치는 sudo 필요 |
| `production` environment | 생성 완료: required_reviewers = sanghyun-io |
| main 브랜치 보호 | 현재 미설정(404 실측) |
| 시크릿 provisioning | 의도적으로 미 수행 |
| 로컬 harness 검증 | 임시 Postgres 기동/stop 멱등 + 빌드·테스트 전부 통과 |
| **보안 테스트** | **27개 테스트 모두 통과** (scripts/ci/runner/security.test.ts) |

## 2. 보안 아키텍처 (P1 수정 완료)

### Root symlink 방지
- **Bundle**: `/Library/Application Support/GamjaWorld/CI/lcm-production/`
  - Root 소유, CI 사용자 읽기/실행만 가능 (쓰기 불가)
  - Runner 바이너리, runsvc.sh, config.sh 포함
  - Manifest 파일로 무결성 검증
- **Working dir**: `/Users/lcm-ci/actions-runner/`
  - CI 사용자 소유 (0700), .credentials/_work/_logs 저장
- **Logs**: `/var/log/gamja-ci/lcm-production/`
  - Root 소유 부모 디렉토리, CI 사용자는 ACL로 파일 쓰기만 가능
- **Plist**: `/Library/LaunchDaemons/...`
  - Root 소유 (0644), Program은 bundle의 runsvc.sh 가리킴
  - WorkingDirectory는 CI의 working dir
  - UserName은 lcm-ci (프로세스는 CI 사용자로 실행)

이 구조는 TOCTOU 공격을 방지합니다: Root의 launchd가 root 소유 바이너리를
실행하므로, CI 사용자가 바이너리를 수정할 수 없습니다.

### PG trust 방지
- TCP 리스너 비활성화 (`listen_addresses=''`)
- Unix socket만 사용 (0700 CI 소유 디렉토리)
- Peer auth (로컬), reject auth (TCP)
- DB 슈퍼유저 = OS 사용자 이름 (peer auth 일치 요구)
- URL: `postgresql://<os-user>@localhost:<port>/lcm_ci_test?host=<socket-dir>&schema=lcm_ci_test`

### CI workflow guards
- `workflow_dispatch` 제거 (ci.yml): 수동 dispatch로 임의 브랜치 실행 방지
- Push to main만 허용 (fork 이벤트는 main에 push 불가)
- Preflight job: repo/ref/event/SHA 검증
- Deploy: verify-ci job이 CI 성공 확인 후 배포

### Token 처리
- `/dev/tty`에서 읽기 (argv/stdin/env/file 아님)
- `ACTIONS_RUNNER_INPUT_TOKEN` env로 config.sh에 전달
- 사용 후 즉시 unset

## 3. 워크플로 인터페이스

- `.github/workflows/ci.yml` — 트리거 `push: [main]`만 (workflow_dispatch 제거).
  `permissions: contents: read`, checkout `persist-credentials: false`.
  Preflight job이 repo/ref/event/SHA 검증 후 build-test 실행.
  pull_request/fork/이슈 콘텐츠 경로 없음(비신뢰 코드 self-hosted 실행 금지 준수).
- `.github/workflows/deploy-pages.yml` — **workflow_dispatch 전용**.
  verify-ci job이 CI 성공 확인, preflight job이 actor 검증 후 deploy 실행.
  job gate: `github.repository == 'sanghyun-io/living-cost-manager' && github.ref == 'refs/heads/main'` +
  environment `production`(required reviewers 통과 없이는 시크릿·배포 불가).
  Wrangler는 tools/wrangler에 pre-install (package-lock으로 고정), npx 사용 안 함.
- Action pin(공식 GitHub actions만, third-party 금지):
  `actions/checkout@3d3c42e5...` (v7.0.1),
  `actions/setup-node@949feb24...` (v7.1.0).

## 4. CI test harness (scripts/ci/)

- `ephemeral-postgres.mjs` — CI 전용 임시 PostgreSQL 16 클러스터.
  **Unix socket만 사용** (TCP 비활성화), peer auth, 0700 socket 디렉토리.
  DB=role=schema 이름 전부 `lcm_ci_test` — test-isolation guard 통과.
  상태 파일에 기록된 자기 uid/PID/dataDir가 아니면 **어떤 프로세스·디렉터리도
  종료·삭제하지 않는다**.
- `host-lock.mjs` — LCM-scoped 호스트 advisory lock.
- `run-workspace-vitest.mjs` — `vitest run --maxWorkers=2` 래퍼.

## 5. runner 설치 키트 (scripts/ci/runner/) — Owner 1회 절차

`README.md` 절차 그대로:
1. `sudo 01-create-account.sh` (비관리자 `lcm-ci` 생성)
2. `sudo 00-bootstrap-bundle.sh` (root-owned bundle 생성)
3. `sudo -u lcm-ci 02-register-runner.sh` (token은 /dev/tty에서 읽기)
4. `sudo 03-install-launchd.sh` (root 0644 plist)
5. `04-verify.sh` 읽기 전용 확인

05-remove.sh는 LCM runner만 해제 (계정·파일·타 제품 러너 보존).
**모든 스크립트는 precondition 검증 후 실행** (중간 중단 방지).

## 6. 게이트 실제 상태와 남은 Owner 결정

- `production` environment required_reviewers: **실제 생성·확인됨**.
- deployment branch policy 하위 엔드포인트는 이 저장소 API 표면에서 404 →
  워크플로 internal `refs/heads/main` exact guard를 게이트로 사용.
- main branch protection(404=미설정)은 **전환 공개 단계에서 Owner 적용 권장**.
- OS 계정: `sudo -n` 불가 → 실행 에이전트 차단. Owner의 1회 sudo 필요.

## 7. 시크릿 전달 절차 (runner 등록·워크플로 공개 이후 단계)

원본 기준은 opskv. provisioning 전 이 워크플로를 실행하면 환경 승인 실패 또는
시크릿 공백으로 배포가 수행되지 않는 것이 기대 동작.

## 8. 로컬 검증 결과 (2026-10-16)

- shared: **197 passed** / web: **664 passed, 1 skipped** (jsdom)
- api: **30 test files / 461 passed** (임시 클러스터)
- marketing: 통과
- **보안 테스트: 27 passed** (root symlink, PG trust, CI guards, token handling, package-lock)
- 이는 **로컬 harness 검증**이며 GitHub Actions run 완료 주장이 아니다.

## 9. 공개(메인 머지)와 롤백

- 공개: Main 리뷰 후 이 브랜치를 머지하면 ci.yml/deploy-pages.yml가 원격 main에
  게시된다. 게시와 동시에 runner가 없으면 push CI가 queue에 대기만 한다.
- 롤백: 워크플로 파일 revert + `05-remove.sh`.
