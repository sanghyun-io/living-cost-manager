# LCM 전용 Mac Mini self-hosted runner — Owner 프로비저닝 런북

상태(2026-10-17, 공식 appRoot 재작성): 코드·워크플로·harness는 브랜치
`feat/ci-runner-a98c952d`에 **로컬 커밋** — 미푸시·미공개. **OS 계정 생성과
LaunchDaemon 설치는 sudo가 필요한 일회성 OS 변경이라 실행 에이전트에서
차단됨**(root 미실행). 아래는 Main 리뷰 통과 후 Owner가 Mac Mini 터미널에서
직접 수행하는 순서다.

## 범위와 경계 (먼저 읽을 것)

- 대상: `sanghyun-io/living-cost-manager` 저장소 **repository-scoped** 등록 1대.
  이름 `lcm-prod-macmini-01`, 라벨 `self-hosted,macOS,ARM64,lcm-production`.
  Harudo(`/Users/sanghyun/actions-runner`)·Figuredeal
  (`/Users/sanghyun/actions-runner-figuredeal`) 리스너에는 절대 손을 대지 않는다.
  수정·중지·재사용 없음, runner group 사용 없음, broad kill/pkill 없음.
- 라벨은 job 라우팅 조건일 뿐 격리 수단이 아니다. 실제 경계 = repo-scoped 등록 +
  비관리자 OS 계정 `lcm-ci`(고유 primary group, admin 아님, sudoers 미설정·
  sudo 불가, password 레코드 없음, shell /usr/bin/false, 홈 0700).
- 신규 유료 자원·GitHub-hosted 실행·OCI SSH·프로덕션 DB·기존 배포 자격증명 복사
  불용. FE 배포는 Cloudflare Pages, environment `production` 시크릿은
  provisioning(docs §5·§7) 이후에만 존재.
- 토큰(등록/제거)은 Owner gh CLI의 stdout 파이프 → root-owned 스크립트 stdin
  전용. argv·파일·로그·echo 어디에도 노출되지 않는다. registration token은
  1시간 만료이며 재사용·`--replace` 없음. 발급은 3단계에서 필요 직전에만.
- 스크립트가 기존 계정/경로/leaf를 발견하면 **무변경 실패**(fresh-install
  전용). 수복·재이미징 경로는 의도적으로 없다(그것이 TOCTOU). 완전 철거는
  06-remove 실행 후 별도 승인 수동 절차.

## 레이아웃

```
/Library/Application Support/GamjaWorld/CI/lcm-production/  root:wheel 0755 (부모, CI 무권한)
  runner-config.env lib.sh register.sh deregister.sh runner-status.sh
  run-runner.sh manifest.txt                          ← root 소유 공개 파일(시크릿 없음)
  app/                                                ← 공식 runner appRoot (lcm-ci 0700)
      (bin/ config.sh run.sh env.sh externals/ .credentials .env .runner _work _diag …)
/private/var/log/gamja-ci/lcm-production/             root:wheel 0700  ← canonical(/var은 symlink)
  launchd.out.log launchd.err.log                     사전 생성 0640 root:wheel, ACL 없음
/Users/lcm-ci/                                        0700 (provisioning 시 1회 생성, 이후 root 무관여)
/Library/LaunchDaemons/com.gamjaworld.lcm-ci-actions-runner.plist   root 0644
```

launchd가 UserName/GroupName으로 uid를 강등한 뒤 root-owned wrapper(run-runner.sh)가
exec되고, wrapper는 leaf 검증 후 공식 `run.sh`를 exec한다(무권한 시점 이후).

## 절차 (리뷰 통과·머지 후)

```bash
cd <living-cost-manager main checkout>          # 또는 승인된 이 worktree

# 1) (sudo) 전용 비관리자 계정 생성 — 계정/홈/설치경로 중 하나라도 존재하면 무변경 거부
sudo scripts/ci/runner/01-create-account.sh

# 2) (sudo) fresh install bundle: pinned v2.338.0 tarball SHA-256 검증 → root 전용
#    staging에서 공식 mode 그대로 해제 → chown lcm-ci → root 소유 부모 아래로 rename
#    → 공개 control 스크립트 + manifest 설치 → 로그 pre-create(ACL 없음)
sudo scripts/ci/runner/02-install-bundle.sh

# 3) 등록. 이 커맨드 하나가 preflight → sudo -v(터미널 비밀번호) → gh 토큰
#    발급·파이프(stdin) → root-owned register.sh(CI uid) 실행. 토큰 argv/에코 없음.
scripts/ci/runner/03-register-runner.sh

# 4) (sudo) root-owned LaunchDaemon 설치·bootstrap (Program=부모의 run-runner.sh)
sudo scripts/ci/runner/04-install-launchd.sh

# 5) 읽기 전용 검증
sudo scripts/ci/runner/05-verify.sh
gh api repos/sanghyun-io/living-cost-manager/actions/runners \
  --jq '.runners[]|{name,status,labels:[.labels[].name]}'
```

체크포인트: 3단계 실행 전 GitHub runner 목록이 0인지 확인(03이 preflight에서
configured probe로 중복을 먼저 거부). 02는 dirty 트리를 거부한다(검토 커밋
고정). 02가 받는 tarball SHA는 `runner-version.env` pin과 정확히 일치해야 하며
불일치 시 leaf 생성 전에 중단된다.

## 롤백

```bash
# 토큰 파이프 = 모든 전제(플리스트/leaf/신원/토큰 shape)가 검증된 뒤에만 서비스 중지
sudo -v
gh api -X POST repos/sanghyun-io/living-cost-manager/actions/runners/remove-token --jq .token \
  | sudo scripts/ci/runner/06-remove.sh
```

`lcm-ci` 계정·leaf 파일·로그·공개 bundle·다른 제품 러너는 삭제하지 않는다.
완전 철거(dscl delete, rm -rf)는 06이 안내하는 별개 승인 수동 절차.

## 실행 계정에서 Owner 홈/시크릿에 접근할 수 있는가?

아니다. runner는 `lcm-ci` uid로 실행되며 `/Users/sanghyun`(0700)·`~/.ssh`·
`~/.config`·Keychain을 읽지 못한다. CI-uid가 실행하는 모든 스크립트는 root가
부모에 설치한 공개 사본이며, repo Owner 홈 경로(0750)를 실행에 의존하지 않는다.
CI가 필요한 도구(Homebrew postgresql@16, setup-node 캐시, 공식 npm)은
world-readable 경로만 사용한다. 첫 job 실행 후 05-verify로 uid 경계를 확인한다.

## 테스트/검증 (실행 에이전트 가능 범위 — root·네트워크·등록 없음)

```bash
(cd apps/web && pnpm exec vitest run --root ../../scripts/ci/runner)   # 48 passed
shellcheck -S warning scripts/ci/runner/*.sh scripts/ci/runner/rootctl/*.sh scripts/ci/runner/lib/*.sh
node --check scripts/ci/release-gate.mjs
```

security.test.ts는 실제 bash/plutil을 픽스처 트리에서 실행한다: symlink leaf 거부,
mode 700 가드, 토큰 shape·stdin 전용·env-to-config·argv 무노출 입증,
rerun 거부(무변경), 공식 tarball mode 보존(fixture-mode 설치), Runner.Listener
--help(비등록), **ACL 검증(allow/inherited/unparseable 거부·deny-only 통과)**, **.runner
pretty-printed 파싱(plutil)**, **gate workflow_id/path(동명 다른 파일 REPRO 거부)**.
2차 리뷰 6건 수정 대조는 docs §9, 폐기된 분리형 아키텍처 정정표는 docs §7.

신원·ACL 경계 요약: root-trusted 경로(앵커~부모, 공개 control 파일, 로그 체인,
LaunchDaemons)는 POSIX owner/mode+writable 검사에 더해 **ACL(0건 또는 deny-only
만 허용)**을 모든 변경 전과 생성 직후 재검사한다. ACL을 임의로 추가/삭제하지
않고 걸리면 조사에 넘긴다. `.runner` 파싱은 CI uid에서만 plutil로 수행되며(root는
exit status와 단순 필드만), agentId/agentName·상수 대조 실패는 제거 절차를
중단한다. 등록 runner 목록(GitHub API)과 workflow_id 바인딩이 저장소 범위
신원의 2차 확인축이다.
