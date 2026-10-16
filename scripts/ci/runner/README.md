# LCM 전용 Mac Mini self-hosted runner — Owner 프로비저닝 런북

상태(2026-10-16 작성, 보안 수정 완료): 코드·워크플로·harness는 브랜치
`feat/ci-runner-a98c952d`에 준비 완료. **OS 계정 생성과 LaunchDaemon 설치는
sudo 권한이 필요한 일회성 OS 변경이라 실행 에이전트에서 차단됨** (`sudo -n` 실패,
`lcm-ci` 계정 없음). 아래는 Owner가 Mac Mini에서 직접 수행하는 순서다.

## 보안 아키텍처 (P1 수정 완료)

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

### CI workflow guards
- `workflow_dispatch` 제거 (ci.yml): 수동 dispatch로 임의 브랜치 실행 방지
- Push to main만 허용 (fork 이벤트는 main에 push 불가)
- Preflight job: repo/ref/event/SHA 검증
- Deploy: verify-ci job이 CI 성공 확인 후 배포

### Token 처리
- `/dev/tty`에서 읽기 (argv/stdin/env/file 아님)
- `ACTIONS_RUNNER_INPUT_TOKEN` env로 config.sh에 전달
- 사용 후 즉시 unset

## 범위와 경계 (먼저 읽을 것)

- 대상: `sanghyun-io/living-cost-manager` 저장소 **repository-scoped** 등록 1대.
  이름 `lcm-prod-macmini-01`, 라벨 `self-hosted,macOS,ARM64,lcm-production`.
- Harudo(`/Users/sanghyun/actions-runner`)·Figuredeal
  (`/Users/sanghyun/actions-runner-figuredeal`) 리스너에는 절대 손을 대지 않는다.
  수정·중지·재사용 없음, runner group 사용 없음.
- 라벨은 job 라우팅 조건일 뿐 격리 수단이 아니다. 실제 경계 = repo-scoped 등록 +
  비관리자 OS 계정 `lcm-ci`(admin 그룹·sudo·패스워드 없음, 홈 0700).
- 이 키트는 신규 유료 자원·GitHub-hosted 실행·OCI SSH·프로덕션 DB·기존 배포
  자격증명 복사를 전혀 사용하지 않는다. FE 배포는 Cloudflare Pages뿐이며 secret
  provisioning은 별도 단계(docs/ci-self-hosted-runner-20261016.md §secrets).

## 절차

```bash
cd /Users/sanghyun/services/living-cost-manager   # main 머지 후, 또는 이 worktree에서

# 1) (sudo 필요) 전용 비관리자 계정 생성 — 이미 있으면 거부(중복 방지)
sudo scripts/ci/runner/01-create-account.sh

# 2) (sudo 필요) Root-owned bundle 생성 (러너 바이너리, manifest)
sudo scripts/ci/runner/00-bootstrap-bundle.sh

# 3) 러너 등록 (token은 /dev/tty에서 읽음, argv 아님)
sudo -u lcm-ci scripts/ci/runner/02-register-runner.sh
# 프롬프트에서 등록 token 붙여넣기 (1시간 만료, hidden input)
# token 획득: gh api -X POST repos/sanghyun-io/living-cost-manager/actions/runners/registration-token -q .token

# 4) (sudo 필요) root 소유 0644 LaunchDaemon 설치, lcm-ci(uid)로 실행
sudo scripts/ci/runner/03-install-launchd.sh

# 5) 검증(읽기 전용)
gh api repos/sanghyun-io/living-cost-manager/actions/runners --jq '.runners[]|{name,status,labels:[.labels[].name]}'
sudo scripts/ci/runner/04-verify.sh
```

체크포인트: 등록 token 요청/사용 전에 GitHub UI·API에서 runner 목록이 0인지
재확인(중복 등록 감지). 00 스크립트는 pinned v2.338.0 tarball을 받아
release본의 SHA-256(`runner-version.env` 기록)과 대조 실패 시 중단한다.

## 롤백

```bash
sudo scripts/ci/runner/05-remove.sh   # LaunchDaemon + GitHub 등록만 해제(토큰 /dev/tty)
```

`lcm-ci` 계정·디렉터리·로그·bundle·다른 제품 러너는 삭제하지 않는다. GitHub-hosted
폴백은 자동 복원되지 않는다(레거시 `api-tests.yml`는 브랜치에서 삭제 완료;
복구는 git history에서 Owner 별도 결정).

## 실행 계정에서 Owner 홈/시크릿에 접근할 수 있는가?

아니다. runner는 `lcm-ci` uid로 실행되며 `/Users/sanghyun`(0700 디렉터리 다수)·
`~/.ssh`·`~/.config`·Keychain을 읽지 못한다. CI가 필요한 파일(Homebrew
postgresql@16 바이너리 `/opt/homebrew`, node setup-node 캐시, 공식 npm)은
world-readable 경로만 사용한다. 첫 job 실행 후 `04-verify.sh`로 uid 경계를 확인한다.

## 보안 수정 요약 (2026-10-16)

### P1 (BLOCKED → 해결)
1. **Root symlink**: Root-owned bundle + CI working dir 분리
2. **PG trust**: Unix socket + peer auth, TCP 비활성화
3. **CI guards**: workflow_dispatch 제거, preflight 검증 추가
4. **Protected source**: verify-ci job으로 CI 성공 확인 후 배포
5. **CI-success-gate**: Deploy가 CI와 동일한 SHA 배포하는지 검증

### P2 (해결)
1. **Bash read**: `/dev/tty`에서 읽기, argv 노출 방지
2. **Token preconditions**: 05-remove.sh가 모든 precondition 검증 후 중지
3. **npx deps**: tools/wrangler에 pre-install, package-lock으로 고정
4. **Owner home unreadable**: CI가 Owner 홈 실행 불가 (bundle만 사용)
