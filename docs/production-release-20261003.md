# 2026-10-03 운영 배포 기록

## 직접 확인한 운영 기준

- FE: Cloudflare Pages `living-cost-manager`, production branch `main`.
- 실제 사용자 도메인: https://living-cost-manager.gamja.top. Pages API의 domains와 API 컨테이너 `APP_BASE_URL`에서 일치 확인.
- 보조 도메인: https://living-cost-manager.pages.dev.
- API: https://api.gamja.top/living-cost-manager/v1, OCI `livingcost-backend`.
- 운영 Compose: `/opt/livingcost/docker-compose.yml`, project `livingcost`. 포트는 컨테이너 내부 4000, published port 없음.
- DB: OCI `gamja-data-postgres`, database `livingcost`, schema `lcm`.
- SSH: `ssh gamja-oci`, `~/.local/bin/gamja-oci-proxy` Bastion. 실제 SSH 설정은 NordVPN retired 2026-09-21을 명시한다.
- 알림: `livingcost-reminders.timer`, 매일 00:00 UTC / 09:00 KST. 같은 backend 컨테이너에서 job 실행. VAPID 설정 존재, 직전 실행 성공 확인. 이번 배포는 고객에게 시험 푸시를 보내지 않는다.

이전 문서의 `livingcost.gamja.world`, Mac 운영 DB, systemd API 배포 스크립트는 현재 운영 절차가 아니다. 기존 미커밋 인프라 파일은 이번 배포 입력으로 사용하지 않는다.

## 변경 전 baseline

- API image: `yny.ocir.io/axuouply2298/livingcost/backend:bef2f7663b89b73945a1e1978eb34890d37e5297`
- image ID: `sha256:a44e9a0895630db4e623215bfc1fdb343a1db336b1fff10a03faf279fb8560cd`
- Pages deployment: `f3bab228-3f5c-4565-8c79-5817b4f557c6`, 같은 commit SHA.
- 기존 migration 6개 완료. 초기 migration의 과거 rolled-back 기록 1개도 존재하며 수정하지 않는다.

## 승인 범위 및 순서

Owner가 서비스 배포와 필요한 기능 schema migration을 명시적으로 승인했다. 기존 Cloudflare/OCI 자원을 사용한다.

1. 제품 변경만 선택적으로 commit하고 해당 commit의 archive로 OCI candidate image를 만든다. `docker build --build-arg RELEASE_SHA=<full-commit> -f apps/api/Dockerfile -t <image>:<full-commit> .`로 identity를 주입한다. 비밀 파일이나 로컬 dirty infra를 전송하지 않는다.
2. OCI release 디렉터리에 기존 Compose와 DB custom-format dump를 보호된 권한으로 백업한다. dump TOC 검증 및 SHA-256 기록, 적용 전 데이터 요약을 기록한다.
3. candidate image의 Prisma로 migration status 확인 후 `migrate deploy`. 추가 필드뿐이며 기존 일정 기준일을 추정하여 채우지 않는다. reset/drop 실행 금지.
4. 기존 Compose의 backend image만 바꾸고 backend만 재생성한다. 기존 터널, DB, 네트워크, 환경 파일은 그대로 사용한다.
5. 내부/공개 health와 `X-Release-Sha`가 전체 commit SHA와 정확히 일치하는지, migration 완료와 기존 데이터 보존을 확인한다. `unknown` identity는 실패다.
6. 실제 API base URL로 정적 FE를 빌드하고 동일 SHA를 release metadata에 기록한다. 기존 Pages 프로젝트의 production branch에 배포한다.
7. 공개 guide HTML, canonical/robots/sitemap/OG, 정적 release metadata와 desktop/mobile 브라우저 여정을 확인한다.

GitHub CLI 인증은 401로 실패했고 Git SSH는 정상이다. 기존 Pages 전용 배포 토큰은 프로젝트 조회에 성공했다. GitHub Actions 성공으로 주장하지 않고 기존 Wrangler Pages 배포 경로를 직접 사용한다.

## 구버전 클라이언트와 롤백

구버전 frontend는 새 청구/검토 필드를 제거해서 PUT한다. API는 버전 lock 이후 같은 transaction에서 기존 필드를 보존해야 한다. 명시적인 null/0은 사용자 편집으로 인정하고, 병합 결과도 검증한다. 이를 배포 전 회귀 테스트한다.

추가된 DB 열은 롤백 때 유지한다. **기존 backend image는 새 필드가 생긴 후 writable rollback 대상으로 안전하지 않다.** 이전 API도 snapshot을 delete/recreate하여 추가 열을 기본값으로 지우기 때문이다.

- FE 문제: 기존 Pages deployment로 rollback 가능. 호환 API를 계속 실행하면 구버전 FE의 생략된 필드를 보존한다.
- API 문제: 같은 schema와 legacy-write 보호를 유지한 수정 image로 forward fix가 우선이다. 긴급히 baseline API로 되돌려야 하면 snapshot 쓰기를 먼저 중단하고 유지보수 상태에서만 실행한다. 고객 쓰기를 받는 상태에서 DB 백업 복원 금지.
- migration 실패: Prisma 상태를 확인하고 candidate 전환을 중단한다. additive migration 적용만으로 이전 API의 기존 필드 동작은 유지된다. destructive down migration 금지.
- DB dump는 재해 복구 자료이며 정상 rollback에 자동 restore하지 않는다. 복구 시에는 먼저 신규 쓰기를 중지하고 덤프 시점 이후 데이터 유실을 별도 판단한다.

## 결과

배포 전 검증: shared 92 / web 113 / API 127 = 332 tests 통과. 격리 PostgreSQL `127.0.0.1:55483/lcm_test?schema=lcm_test` 사용. 전체 production build와 정적 guide 5개 HTML/canonical/JSON-LD/PNG/sitemap 검사 통과. Chromium 로컬 API 동기화·충돌·계정 삭제·다른 탭 데이터 삭제 여정 통과. desktop 1440 / tablet 1000 / mobile 390 완료 상태 양식과 모든 guide overflow/런타임 오류 검증 통과. 별도 UI 작업의 light/dark 전후 스크린샷과 로컬 데이터 안전 E2E도 통과했다.

독립 reviewer가 지적한 legacy PUT 데이터 손실, 완료 상태 설명 overflow, 공유 텍스트의 수입 역산 가능성, 작은 비율 글자 대비, 모바일 필드 라벨을 수정했다. 최종 독립 리뷰에서 남은 release blocker 없음.

운영 사전 백업: `/opt/livingcost/releases/20261003-billing-seo/predeploy.dump` (36,275 bytes, TOC 90 lines), 같은 디렉터리 `predeploy.dump.sha256`, `compose.before.yml`, `image.before.txt`. OCI에서만 보관하며 비밀/고객 자료를 Git에 포함하지 않는다.

gamja-ops `verify-assets.rb` 통과. `check-local-drift.rb`는 기존 다른 서비스 및 퇴역 Mac 백업/LaunchDaemon 기록 때문에 실패했다. 실제 LCM 운영 경로는 위의 live SSH/CF 증거로 확인했다.

### 실제 운영 배포 완료

- 배포 SHA: `85f7a52308d33b1a61dbe46c03f5ec05d82f8e91`.
- 원격 source branch: `release/billing-seo-20261003`. 기존 `refactor/web-page-hooks` 계보와 원격 main 계보는 갈라져 있어 main push가 non-fast-forward로 거부됐다. 강제 push하지 않았다. 원격 main을 배포 소스로 사용했다고 주장하지 않는다.
- OCI image: `yny.ocir.io/axuouply2298/livingcost/backend:85f7a52308d33b1a61dbe46c03f5ec05d82f8e91`; image build ID `d7f9463d4564`. 정확한 Git archive에서 OCI에서 빌드했으며 이번 image를 OCIR에 push하지는 않았다.
- 승인 migration 적용 완료. Prisma `migrate status`: 7 migrations, schema up to date. 전후 기존 FixedCost의 새 필드 제외 내용 digest와 개수 동일.
- 기존 `/opt/livingcost/docker-compose.yml`의 backend image 한 줄만 교체. backend만 `up -d --no-deps --pull never`. 터널/DB 재생성 없음.
- 내부 health와 공개 health HTTP 200, `X-Release-Sha` 정확히 일치.
- Pages deployment: `6bf89f34-d2e9-48fd-a036-8f8a29c270e4`, production, `2026-10-03T14:45:39.275889Z` success. 전용 기존 토큰과 설치된 Wrangler 4.131.1로 직접 배포했다.
- FE `release-meta.json`: 사용자 도메인과 pages.dev 모두 같은 배포 SHA 확인.
- 보호된 DB 백업 SHA-256 재검증 통과. 사용자 18 / 기존 고정비 8 유지. 테스트 계정 정리 후에도 기존 FixedCost digest 동일.

### 실제 운영 검증

- 목적별 임시 계정/워크스페이스 1개를 생성하고, 공개 API 로그인/CORS → 새 청구 필드 PUT/GET → 같은 버전 구버전 payload의 필드 보존 → 오래된 버전 409 → 실제 계정 삭제를 검증했다. 메일/푸시 발송 없이 수행했고 ID로 제한한 finally 정리 및 계정/워크스페이스 삭제 확인을 완료했다.
- 공개 guide 5개 모두 redirect 없는 HTTP 200, Korean static HTML, 단일 h1, canonical/index/JSON-LD 확인. dashboard root는 noindex. 알려지지 않은 guide는 HTTP 404.
- social PNG `image/png`, 1200×630; sitemap 5개 URL, robots와 llms.txt HTTP 200.
- 운영 Chromium desktop 1440 / mobile 390: guide → dashboard → 연간 결제 등록 → 30일 전체 청구액 → 새로고침 → 샘플 왕복 보존, API CORS 통과. 새 브라우저 context의 로컬 데이터만 사용했다. runtime error/가로 overflow 없음.
- JavaScript를 끈 브라우저에서도 계산 안내 한국어 본문·제목이 표시됨을 확인했다.
- screenshot evidence: Mac 임시 디렉터리 `lcm-ui-preview/production-{guide,dashboard}-{390,1440}.png` (OpenCode approved temporary root 아래).
- on-demand local API/web/임시 PostgreSQL은 모두 종료했다. 상시 Mac 운영 서비스는 추가하지 않았다.

### 외부 후속 및 운영 유의점

- Search Console 인증 수단이 제공되어 있지 않아 등록/색인 요청을 수행했다고 주장하지 않는다. 제출 대상 sitemap: `https://living-cost-manager.gamja.top/sitemap.xml`.
- 검색 노출/순위/실제 유입 성과는 배포만으로 입증되지 않는다. 현재 중앙 analytics 수집이나 새 유료 리소스는 도입하지 않았다.
- 미래 자동 배포를 재개하려면 릴리스 source branch와 원격 main의 기존 배포 소유권 변경을 검토하여 통합해야 한다. 현재 production identity는 위 고정 SHA이며 GitHub Actions 완료를 주장하지 않는다.
- 이전 FE rollback deployment는 위 baseline 항목에 있다. DB 필드 보존을 위해 FE rollback 중에도 호환 API를 유지한다. 정상 고객 쓰기가 있는 상태에서 이전 DB dump를 복원하지 않는다.
