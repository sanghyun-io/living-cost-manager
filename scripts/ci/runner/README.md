# LCM 전용 Mac Mini self-hosted runner — Owner 프로비저닝 런북

상태(2026-10-16 작성): 코드·워크플로·harness는 브랜치 `feat/ci-runner-a98c952d`에
준비 완료. **OS 계정 생성과 LaunchDaemon 설치는 sudo 권한이 필요한 일회성 OS
변경이라 실행 에이전트에서 차단됨** (`sudo -n` 실패, `lcm-ci` 계정 없음). 아래는
Owner가 Mac Mini에서 직접 수행하는 순서다.

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

# 2) 등록(1시간 만료 ephemeral registration token은 stdin으로만 — argv 금지)
#    gh 출력은 파이프로만 전달하고 터미널에 띄우지 않는다.
gh api -X POST repos/sanghyun-io/living-cost-manager/actions/runners/registration-token -q .token \
  | sudo -u lcm-ci /bin/bash "$(pwd)/scripts/ci/runner/02-install-runner.sh"
#    (실패·중단 시 재시도: 02는 .credentials/.env가 있으면 중복 등록을 거부한다.
#     부분 등록이면 sudo scripts/ci/runner/05-remove.sh 후 2→3.)

# 3) (sudo 필요) root 소유 0644 LaunchDaemon 설치, lcm-ci(uid)로 실행
sudo scripts/ci/runner/03-install-launchd.sh

# 4) 검증(읽기 전용)
gh api repos/sanghyun-io/living-cost-manager/actions/runners --jq '.runners[]|{name,status,labels:[.labels[].name]}'
sudo scripts/ci/runner/04-verify.sh
```

체크포인트: 등록 token 요청/사용 전에 GitHub UI·API에서 runner 목록이 0인지
재확인(중복 등록 감지). 02 스크립트는 pinned v2.338.0 tarball을 받아
release본의 SHA-256(`runner-version.env` 기록)과 대조 실패 시 중단한다.

## 롤백

```bash
sudo scripts/ci/runner/05-remove.sh   # LaunchDaemon + GitHub 등록만 해제(토큰 stdin)
```

`lcm-ci` 계정·디렉터리·로그·다른 제품 러너는 삭제하지 않는다. GitHub-hosted
폴백은 자동 복원되지 않는다(레거시 `api-tests.yml`는 브랜치에서 삭제 완료;
복구는 git history에서 Owner 별도 결정).

## 실행 계정에서 Owner 홈/시크릿에 접근할 수 있는가?

아니다. runner는 `lcm-ci` uid로 실행되며 `/Users/sanghyun`(0700 디렉터리 다수)·
`~/.ssh`·`~/.config`·Keychain을 읽지 못한다. CI가 필요한 파일(Homebrew
postgresql@16 바이너리 `/opt/homebrew`, node setup-node 캐시, 공식 npm)은
world-readable 경로만 사용한다. 첫 job 실행 후 `04-verify.sh`로 uid 경계를 확인한다.
