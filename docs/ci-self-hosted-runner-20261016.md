# Living Cost Manager — CI/CD self-hosted runner 전환 (2026-10-16~17)

Owner 승인(qa): "기존 Mac Mini에 별도 실행계정으로 분리한 LCM 저장소·운영 환경
전용 러너를 등록하고 CI와 FE배포 GitHub Actions 전환" → **전용 러너 전환 승인**.
본 문서는 그 승인의 LCM 범위 실행 기록과 Main·Owner 후속 단계 인터페이스를 담는다.
전사 기준은 `sanghyun-io/gamja-ops`
`policies/ci-cd-github-actions-macmini-runner-policy.md`(시행 2026-10-16)이며,
**이 전환은 LCM 저장소만 수행한다 — 다른 제품이 마이그레이션된 것이 아니다.**

> 이전 문서/보고서(`SECURITY_FIXES_COMPLETE.md`, `SECURITY_REVIEW_RESPONSE.md`)가
> 주장한 "bundle/working 분리 아키텍처", "GitHub Free는 deployment branch policy
> 미지원(404)"는 **모두 잘못**이었다. 각각의 근거 없는 주장과 실제 재검증 결과를
> §7에 기록하고 문서 자체는 삭제했다.

> **2026-10-18 실효 상태(단일 원본: gamja-ops
> `runbooks/lcm-macmini-ci-runner-20261017.md` §6)** — 본 문서의 나머지 서술(lcm-ci
> 전용 계정·LaunchDaemon·root 절차 01→04)은 **설계/계획(2026-10-16~17) 기록**
> 으로 보존하며, 현재와 혼동하지 않는다. 실제: runner `lcm-macmini`(repo-scoped
> id 21)은 **owner uid sanghyun의 user-scope LaunchAgent**로 실행 중 — 전용
> OS계정 경로는 미실행이므로 **실행 격리 미확보**(편차 기록, Owner 결정 대기).
> 워크플로 `ci.yml` 단일 공개(api-tests.yml 제거), run 39048745412 push main
> success로 FE 배포 CI 전환됨(API는 의도적 a2c7bd9 유지). CF 배포 시크릿:
> `production` environment 2개 이름 전달 완료(opskv baseline 등록·provider
> 읽기 검증) + repository 스코프 2개 유지 — environment 같은 이름 키가 repo
> 키를 **shadow**하며 자동 fallback은 없다(env 값 오류 시 job 실패, 무음
> 강등 없음). repo 2개는 **수동 롤백 수단**(env 사본 의도적 제거 시 repo로
> 복귀)으로만 온존하며, **gated deploy 기능 증명 전 narrowing 미완료**
> (staged), 제거는 별개 승인.

## 1. 실행 상태 요약 (2026-10-17 00:20 KST 시점)

| 항목 | 상태 |
| --- | --- |
| runner 키트·워크플로·테스트 | `feat/ci-runner-a98c952d` 브랜치 **로컬 커밋** (미푸시·미공개) |
| 아키텍처 | 공식 runner 단일 appRoot 설계로 전면 재작성 (§2) |
| 공식 패키지 실측 검증 | v2.338.0 osx-arm64 tarball SHA-256 일치, 일반 사용자 임시 디렉터리에서 `bin/Runner.Listener --help` 정상(exit 0), config.sh/run.sh가 자기 디렉터리를 appRoot로 self-locate함을 소스로 확인 (§3) |
| kit 테스트 | **48 passed** (security.test.ts + release-gate.test.ts, 픽스처 트리에서 실제 bash/plutil/node 실행 — regex 존재 검사 아님; 2차 리뷰 6건 회귀 테스트 포함) |
| shellcheck / `bash -n` / `node --check` / `plutil -lint` / YAML parse | 전부 통과·valid |
| OS 계정·LaunchDaemon | **미존재·미설치** — root 실행은 리뷰 통과 후 Owner 터미널 전용 (§6) |
| runner 등록 | **미 수행** — registration token 발급 자체가 아직 없음(의도) |
| GitHub Actions 실행 | **미 수행** (워크플로 미공개 + runner 미등록) |
| production environment | 실제 존재, required_reviewers=sanghyun-io(prevent_self_review=false) 유지하면서 §4의 정석 경로로 main 분기 정책 적용 완료 |
| main 브랜치 보호 | 실측: 존재, allow_force_pushes=false, allow_deletions=false, required PR/status 없음, enforce_admins=false — **본 세션에서 변경 없음(약화 없음)** |
| 시크릿 provisioning | 의도적 미 수행 |
| 로컬 harness(기존) | 임시 Postgres(유닉스 소켓·peer auth·TCP 없음, API 461 테스트 구성) 무변경 유지 |

## 2. 아키텍처 — 공식 단일 appRoot (이전 분리형 키트의 치명적 버그 대체)

이전Debugger 키트는 root 소유 bundle(`/…lcm-production/bin,config.sh`)과 CI 소유
`working/` 디렉터리를 분리하는 자체 발명 구조였고, 그 전제 자체가 공식
러너와 양립 불가였다:

1. **config.sh/run.sh는 자기 파일 위치를 appRoot로 cd한다** (v2.338.0 소스
   확인: `cd "$DIR"` 후 `./bin/Runner.Listener configure`, `./env.sh`가 CWD의
   `.env`를 읽고 씀). `.credentials/.env/.runner/_work`은 **바이너리와 같은
   디렉터리**에 생성된다. bundle에서 실행하면 등록 상태가 bundle(root 소유)에
   쓰이려 하고, working에서 실행하면 `$(dirname $0)` 의존성이 깨진다.
2. root 소유 0755 `lcm-runner/` 아래에서 **CI uid가 mkdir하는 것 자체가
   불가**(부모 쓰기 권한 없음) — 등록 절차가 원천 실행 불가 상태였다.
3. `--replace`는 이름 충돌 시 기존 등록을 파괴하고, 스크립트가 Owner 홈
   0750에 있어 CI가 읽을 수 없었다.

**새 구조:**

```
/Library/Application Support/GamjaWorld/CI/lcm-production/   ← PARENT (root:wheel 0755)
  runner-config.env  lib.sh  register.sh  deregister.sh
  runner-status.sh   run-runner.sh         manifest.txt      ← root 소유 공개 파일(시크릿 없음)
  app/                                                        ← LEAF = 공식 appRoot 그대로
                                                                (lcm-ci 소유 0700, tarball 원본
                                                                 mode 보존: bin/config.sh/run.sh/externals…)
/private/var/log/gamja-ci/lcm-production/                      ← canonical(/var은 macOS symlink);
                                                                  0700 root, 파일은 root가 사전 생성
  launchd.out.log launchd.err.log                               0640 root:wheel, **ACL 일체 없음**
                                                                (launchd가 root로 fd를 열어 uid
                                                                강등 자식에게 상속 — CI는 경로
                                                                탐색 권한 없이 서술자로만 씀)
```

- **fresh install 전용**: root는 staging(root 전용 0700, 부모 안)에서 tar 검증·
  해제→ staging 내부에서 단 한 번 chown -R lcm-ci → mode 700 → root 소유 부모에
  `mv`(rename)로 leaf 배치. CI는 부모에 쓰기 권한이 없어 leaf 경로 교체 불가.
  그 후 root는 leaf를 traverse·재귀 chown/chmod·실행하지 않는다. leaf/공개파일
  기존 존재 시 스크립트는 **변경 없이 실패**(수복 경로 없음 — 수복이 곧 TOCTOU).
- **신분 강등 순서**: LaunchDaemon Program은 root 소유 `run-runner.sh`.
  launchd가 UserName/GroupName으로 uid를 먼저 강등하고 wrapper를 exec하므로
  wrapper가 leaf의 공식 `run.sh`를 exec하는 순간은 이미 무권한 CI(uid 확인·
  leaf 실디렉터리/오너/mode 700/regular+exec 검사 후). 공식 config.sh/run.sh도
  root 실행을 스스로 거부한다.
- **svc 미사용**: v2.338.0 osx 패키지에는 svc.sh/runsvc.sh가 없다(실측).
  포그라운드 `run.sh` + KeepAlive(SuccessfulExit=false) +
  RUNNER_MANUALLY_TRAP_SIG=1 조합이 공식 종료/재시작 의미론과 일치:
  재시도성 코드(2/3/4)는 run.sh 내부 루프, clean exit 0(remove 후 등)은
  재시작 안 함. hard stop 후 수동 재개는 `launchctl kickstart`.
- **토큰 흐름(argv·로그·파일 무노출)**: Owner 터미널에서
  `gh api ...registration-token --jq .token | sudo -n -u lcm-ci <parent>/register.sh`
  — sudo argv에 토큰 없음, register.sh는 stdin에서만 읽고 shape 검사 후
  공식 `ACTIONS_RUNNER_INPUT_TOKEN` 환경변수로 config.sh 단일 서브프로세스에
  스코프 전달(공식 메커니즘은 바이너리에서 실증; bin/Runner.Listener.dll에
  ACTIONS_RUNNER_INPUT_* 마스킹/제거 문자열 존재). remove도 동일 구조
  (`06-remove.sh`가 stdin 토큰을 받은 뒤에만 bootout, 신원 검증은 CI uid의
  root-owned probe가 담당). `--replace` 없음, 중복/부분 상태 거부.
- **격리 경계**: repository-scoped 등록(토큰이 저장소 범위 강제) + 비관리자
  `lcm-ci`(고유 primary group, admin 아님, password 레코드 없음, shell false,
  홈 0700 fresh-only). CI는 Owner 홈·`~/.ssh`·`~/.config`·키체인에 접근하지
  않으며 키트 실행 코드 어디에도 Owner 홈 경로 없음(테스트로 가드).

## 3. 공식 패키지 실측 근거 (2026-10-16, 일반 사용자·보호 임시 디렉터리)

- `actions-runner-osx-arm64-2.338.0.tar.gz` SHA-256 =
  `df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2` (pinned 일치).
- tar 상위 mode: config.sh/run.sh/env.sh/safe_sleep.sh/run-helper.sh.template
  = 0755, `bin/Runner.Listener` = 0755 — tar 해제 시 mode 자동 보존 확인
  (blanket chmod 불필요, 오히려 금지).
- 패키지 내부에 externals/node2{0,4}/bin/npm·npx·corepack **정당 symlink 존재**
  → "tar 전체 symlink 금지"는 공식 패키지와 양립 불가. 금지 대상은 root 측이
  탐색하는 경로(앵커 조상·부모·leaf 엔트리·로그)로 한정.
- `./bin/Runner.Listener --help` → exit 0, `./config.sh`·`./run.sh` 엔트리
  문서화. `--version` = 2.338.0. 등록 없이 동작(증거 테스트로 고정).

## 4. GitHub 게이트 실제 상태 (본 세션 API 적용·확인, 시각 기록)

- **production environment** (id 24472390735):
  - `GET …/environments/production`: required_reviewers = sanghyun-io,
    prevent_self_review=false, (2026-10-16 22:3x KST 적용 전) `deployment_branch_policy: null`.
  - **PUT** `…/environments/production` — 리뷰어·prevent_self_review·wait_timer
    보존(`reviewers:[{id:62102969}]` 형식; `reviewer_id` 형식은 422) +
    `deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}`.
  - **POST** `…/environments/production/deployment-branch-policies`
    `{name:"main", type:"branch"}` → policy **id 63284906** 생성.
  - **GET 확인**: `deployment_branch_policy` 비-null(custom=true), 리뷰어
    sanghyun-io 유지, 목록 API `/deployment-branch-policies`(하이픈) 1건.
  - 이전 세션의 "404=Free 플랜 미지원" 주장은 **오타 경로
    `/deployment_branch_policies`(언더스코어)**에서 기인한 오류였다. 무료/유료 주장
    근거 없음 — 실제 오류 본문이 유료 기능을 지목하면 그때 별도 보고.
- **main branch protection** (읽기 전용 실측, **본 세션 무변경**):
  존재·적용됨. allow_force_pushes=false, allow_deletions=false,
  required_status_checks=null, required_pull_request_reviews=null,
  required_signatures=false, enforce_admins=false, lock_branch=false.
- 소스 신뢰 모델: main 유입은 Owner push + 머지 전 수동 독립 리뷰. solo Owner
  자기 승인 불가로 required PR은 deadlock이라 미설정(의도, 문서로 대체 —
  가짜 PR 강제 없음). fork는 main push 불가, ci.yml은 push:[main] 전용이라
  비신뢰 PR/dispatch가 runner에 도달하는 경로 없음.
- **GITHUB_TOKEN**: 저장소 기본 `default_workflow_permissions=read` 유지.
  ci.yml build-test는 `contents: read`만 (upload-artifact은 Actions 런타임 artifact
  service 어서셔 — repo API `actions: write` 불요, 2차 리뷰 후 제거; 첫 실런에서
  권한 오류가 실증되면 근거와 함께 최소 재선언), deploy의 verify-ci·deploy job만
  `actions: read`(게이트 조회·아티팩트 다운로드).
- **CI-success gate**(2차 리뷰 후 hardened): verify-ci가 워크플로 id를 **고정
  경로 API** GET `/actions/workflows/ci.yml`로만 발견하고 run 조회도
  `/actions/workflows/{id}/runs` 스코프 엔드포인트 사용 → release-gate.mjs gate가
  API JSON 파싱 시 **workflow_id==meta.id + meta.path===".github/workflows/ci.yml"
  (검증기 코드 상수 강제, 호출자 임의 id 파라미터 경로 없음)** + event=push/
  head_branch=main/head_sha exact/status=completed/conclusion=success + run별 최신
  attempt만 인정(동일 표시 이름의 다른 워크플로 파일 성공run 거부 — REPRO 회귀
  테스트). 통과 시 runId·runAttempt·workflowId를 출력하고 deploy 아티팩트 검증
  (build-info workflowPath + content digest 재계산 + attempt/workflow-meta 대조)
  에 바인딩 — 승인 후 재빌드 없음.

## 5. 워크플로 키트/인터페이스

- `.github/workflows/ci.yml`: push:[main] + preflight(repo/ref/event/SHA exact)
  → build-test(임시 PG 유닉스 소켓, shared/web/api/marketing/kit 테스트) →
  **prod-env FE 빌드 + release-meta + build-info(digest) + 아티팩트 업로드**
  `lcm-release-<sha>`(retention 7일). workflow_dispatch 없음.
- `.github/workflows/deploy-pages.yml`: workflow_dispatch 전용 →
  verify-ci(게이트) → preflight(저장소/ref/actor=sanghyun-io) →
  deploy(environment=production, required reviewer + main-only branch policy
  로 시크릿 노출) → 아티팩트 다운로드(run-id·attempt 고정) → release-gate
  verify(digest) → tools/wrangler 잠금본 `npm ci --ignore-scripts`(시크릿
  없는 단계)로 설치된 공식 CLI만 사용(npx 없음) → 배포 → 양 Origin release-meta
  실측 대조. CF 시크릿은 deploy step env에만 주입, argv·stdout 무복사.
- runner 키트: `scripts/ci/runner/README.md` 절차(01→02→03→04→05, 롤백 06).

> **2026-10-18 통합 정정(2026-10-18 2차 수정 포함)**: `.github/workflows/deploy-pages.yml`과
> 분리 `verify-ci` 크로스-run 게이트는 **폐기**됐다. 실제 관찰된 실패는 "Artifact not
> found"였고 원인은 download-artifact의 **기본 스코프가 자기 run을 보는 것**이었다.
> 이 때문에 "다른 run 아티팩트에 elevated PAT가 필요하다"는 보편 요구가 **있는 것처럼
> 쓰인 이전 서술은 부정확**하다 — 동일 저장소에서 GITHUB_TOKEN에 `actions: read`
> 권한과 run-id 지정이 있으면 크로스-run 읽기는 기술적으로 가능하다. 다만 본 설계는
> 같은 run 전달로 충분하므로 크로스-run도 PAT도 **불필요**하며, 그래서 배포를 ci.yml의
> `deploy` job으로 **같은 run에 통합**했다 —
> `needs: [preflight, build-test]`, `environment: production`(required Reviewer=Owner
> + main-only 정책)으로 승인 전 대기, 같은 run 아티팩트를 기본 토큰으로 내려받아
> release-gate.mjs verify(digest·attempt·workflow-meta) 후 재빌드 없이 배포, 양 Origin
> release-meta 실측 대조. 위 §4/§5의 verify-ci·deploy-pages 서술은 이 정정으로 대체된다.

## 6. 남은 단계와 Owner 승인 경계 (순서 고정)

1. **Main/독립 리뷰 통과** (현재 코드 — root 실행은 리뷰 통과 전까지 금지).
2. 머지·푸시(Owner 결정): 브랜치 → main 병합으로 워크플로 공개.
3. Owner 터미널 1회 프로비저닝(README §절차): `sudo 01` → `sudo 02` →
   `03-register`(sudo -v + gh 파이프, 1시간 token, 재시행 시 중복 가드가
   먼저 막음) → `sudo 04` → `sudo 05-verify` + gh runner 목록 확인.
4. 시크릿 provisioning(opskv 기준) 후 배포 승인.
5. 하네스 첫 실run·공개 배포 확인이 끝나야 "전환 완료" — 현재 어떤 단계도
   완료 주장 불가. 본 문서는 상태 기록이지 강제가 아니다.

차단/미수행(정직 기록): OS 계정·runner 미생성(권한 없음), 등록 token 미발급,
Actions run 0회, 배포 0회, GitHub-hosted 폴백 없음(레거시 api-tests.yml는
브랜치에서 삭제 유지, 복구는 별도 Owner 결정).

## 7. 이전 주장 정정 대조표

| 이전 주장 | 재검증 결과 |
| --- | --- |
| root bundle + CI working 분리가 "TOCTOU 방지 아키텍처" | 공식 미지원 self-locate semantics와 모순, CI의 root 0755 디렉터리 mkdir은 권한상 불가로 절차 자체가 불능 |
| "GitHub Free는 deployment branch policies 미지원(404)" | 오타 경로(`/deployment_branch_policies`)에서 비롯된 것. 올바른 경로 PUT+POST로 실제 적용됨(§4) — 플랜 제한 주장 취소 |
| plist가 bundle의 runsvc.sh 실행 | v2.338.0 osx 패키지에 runsvc.sh 존재하지 않음(실측). run.sh + root wrapper로 대체 |
| "모든 파일 chmod 644 후 bin만 blind chmod" | 네이티브 바이너리 mode 파괴 원인. 공식 tar mode 보존 방식으로 대체 |
| `--replace`로 재등록 허용 | 이름 충돌 파괴. 거부로 대체(중복/부분 → remove 선행) |
| "32개 보안 테스트 통과 = 아키텍처 안전" | 대부분 문자열 존재 검사 + 잘못된 아키텍처 고정. 실제 bash를 픽스처에 실행하는 43개 동작 테스트로 대체 |
| 토큰을 /dev/tty 히든 입력 | Owner gh 파이프 stdin + root-owned register.sh가 CI uid 환경전달하는 공식 방식과 호환되도록 재설계(터미널 복붙 실수면 CRLF/공백 shape 검사로 차단) |

## 8. 로컬 검증 결과 (재현 명령)

```bash
cd scripts/../..            # repo root
(cd apps/web && pnpm exec vitest run --root ../../scripts/ci/runner)
  # → 43 passed (2 files)
shellcheck -S warning scripts/ci/runner/*.sh scripts/ci/runner/rootctl/*.sh scripts/ci/runner/lib/*.sh
bash -n <each script>; node --check scripts/ci/release-gate.mjs
pnpm test:marketing          # 무변경 통과
```

(공식 패키지 proof 테스트는 보호 캐시 tarball이 있는 머신에서만 실행되고
CI에서는 자동 skip. CI 네트워크·근무 계정 홈에 바이너리를 받지 않는다.)

## 9. 2차 독립 리뷰 FAIL(1387814) → 6건 수정 (2026-10-17)

독립 리뷰 ses_ebaa9ac3…가 43 pass에도 실제 버그 6건을 지적, 모두 수정 후
**48 passed**로 재커밋. 회귀 테스트를 각 항목에 신설했고(가능 항목은 이전
소스에서 실패했어야 할 케이스 명시):

1. **P1 ACL 미검사**: POSIX owner/mode만 보면 allow·inherited ACE가 root 0755
   부모/공개파에서도 다른 주체 write/delete 가능. lib `expect_acl_safe` 신설 —
   ACE 0건 또는 엄격 deny-only만 허용, 임의 allow(read전용 포함)·unparseable
   줄은 fail-closed. 적용 지점: 01(/Users, 미래 경로 체인, 생성 후 홈),
   02(앵커→부모 전 component·생성 직후 재검사·로그 체인·공개 파일·사전 로그
   파일, 모든 변경/핸드오프 이전), 03·04(부모+공개파일+LaunchDaemons),
   06(precondition). **ACL 추가/삭제/변경 없음** — 합법 시스템 deny-only는
   통과, blocker성 allow ACE는 조사 후 Owner 결정(문서화 차단).
2. **P2 01 lib 미import**: `reject_symlink_components` 호출하나 source 없어
   command-not-found로 전체 불능 → 정상 source + 프리플라이트 재편. 정적
   가드 테스트(헬퍼 사용 스크립트 전수 source 검사).
3. **P2 mkdir birth mode**: `umask 077` + `mkdir -m`로 0755 기본 창 제거.
4. **P2 /var symlink + 부분 실패 순서**: 로그 기본 경로 canonical
   `/private/var/log/...` 통일(env·문서), 02를 페이즈화해 실패 가능 검증과
   root 소유 산출물 생성을 모두 끝난 뒤 **CI 소유권 핸드오프(chown→rename)
   를 최후 변경**으로 이동. 핸드오프 전 실패 시 leaf·control 파일·manifest·
   로그 잔존 0(테스트 단언). 핸드오프 후 예외 시 root-private staging이라
   trap 정리 외 자동조치 없음, 재실행 거부+PARTIAL 보고(위험 재시도·자동
   삭제 없음).
5. **P2 .runner 파서**: 실제 upstream은 pretty-printed JSON — sed 근사가
   정당 runner를 거부. `/usr/bin/plutil -extract … raw`(JSON 지원, 실측)로
   표준 파싱, agentId 숫자·agentName 상수 exact, malformed/type 오류
   fail-closed, 파싱은 CI-uid 스크립트만 파일 경로로 수행(root은 exitcode와
   단순 필드만). 공식 바이너리 문자열 실증: `.runner` 키는 agentId/agentName/
   clientId — 저장소 URL 필드 없음. 저장소 바인딩은 registration token 자체의
   repo scope + 운영자 gh API(05-verify·06 사전 조회)로 확인(문서 정정).
6. **P2 gate 신원 + 권한**: 표시 이름만 검사는 REPRO(동명 `not-ci.yml` 성공run)
   통과 — workflow_id==meta.id + meta.path 상수 강제 + id 스코프 엔드포인트로
   수정. build-test `actions: write` 제거(upload-artifact는 런타임 artifact
   service 어서셔; 게이트 job만 actions: read 유지).

root 실행·등록·푸시는 여전히 0회(리뷰 대기 상태 유지).
