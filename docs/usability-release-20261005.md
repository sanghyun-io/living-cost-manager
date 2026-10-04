# 사용성 10개 기능 릴리스

## 배포 전 검증

- 기능별 목록과 구현 commit: [백로그](./usability-backlog-20261004.md).
- 후속 리뷰 수정: 가져오기 동기 저장 및 지연 effect 재쓰기 방지, 알려진 버전별 복구 키 종류별 3개 보존/quota 시 최신 기존 사본 보호, 하이픈 이름·ISO 날짜와 음수 금액 구분, `.5개월` 지원 및 정확한 일정 미계산 안내, snapshot identity 단축·날짜 갱신 포함 검토 목록 memo, 고정 Playwright 의존성·OS 임시 경로.
- 전체 `pnpm verify:usability`: shared **92**, web **131**, API **129** = **352** tests, 소유권 guard 2, service-worker 3, production builds, Chromium 1440/390 사용성, 로컬 데이터 보존 및 격리 API 동기화 회귀 통과.
- `LCM_VERIFY_INJECT_FAILURE=after-db`: exit 1 및 임시 PostgreSQL 종료/디렉터리 삭제 확인. 정상 실행도 임시 프로세스/DB 정리 완료.
- 로컬 검증 산출물은 loopback API를 사용하므로 배포에 사용하지 않는다. 배포 FE는 최종 Git archive에서 실제 운영 API URL로 새로 빌드한다.
- `b9aee69` 대비 Prisma schema/migrations 및 GitHub workflow 변경 없음. 기존 양쪽 Git 계보 보존, 강제 push 없음, 기존 dirty 원본 작업트리 보존.

## 운영 및 롤백 계약

기존 [운영 runbook](./production-release-20261003.md)의 durability follow-up을 따른다. OCI backend만 digest pin으로 재생성하고 Cloudflare Pages에 같은 source SHA를 direct upload한다. Mac은 검증/빌드 전용이다.

직전 baseline: `b9aee691b09662849f5cca3a3690d0e3c32d3130`, OCI `sha256:713d1e83d71a173f02072cf2619cf1b85ff8101c6176623e2438d8b44d0a0bdc`, Pages `526b4024-b7c2-4e24-b094-3f28b4f6f4a0`. 문제 시 해당 호환 image와 Pages deployment로 쌍을 되돌린 뒤 공개 identity와 DB readiness를 확인한다. DB restore/reset 및 migration은 이번 배포 절차에 포함하지 않는다.

아래 운영 증거는 실제 실행 후 추가한 기록이다. 실행 source SHA와 이후 증거/검증 스크립트 commit을 구분한다.

## 고정된 릴리스 입력

- Source SHA: `e44808e28da2f9d91b1b50bd41ed6cb0f079f786`. 기능 branch tip `1333203`과 tree 동일; origin/main에 정상 push. 이전 main/release 계보 모두 포함.
- 최종 tree의 `pnpm verify:usability` 재실행도 352 tests/전체 build/모든 브라우저 회귀 통과. 동일 millisecond 복구 사본 정렬 회귀를 추가하고 독립 reviewer가 테스트 재실행 후 blocker 없음을 확인했다.
- Clean source tar SHA256: `70aa7bae5e08e299cbc77b143554b8b44b820d33d4c62caea29113dc430d519a`.
- Production FE tar SHA256: `8c3277b22d0de1fdeeee512a5a4f5b75afb5083dab829e80ae431dad485b3f3e`. 실제 API URL 포함/loopback URL 없음, 로컬·OCI 보관본 checksum 일치.
- OCIR 원격 manifest 및 digest pull, platform `linux/arm64`, revision label 검증: `yny.ocir.io/axuouply2298/livingcost/backend@sha256:c565ec1b63192338dd7570db5293f8b7d9ff6d76ec414737b85532d414673be6`. baseline digest도 pull/revision 검증 완료.
- 보호된 OCI 디렉터리: `/opt/livingcost/releases/usability-e44808e28da2f9d91b1b50bd41ed6cb0f079f786/`. dump 37,095 bytes, mode0600, TOC90, SHA256 `4ca00e07861362e3eaf4c3b720fa04843f82f9c318cf05dd8752a1e68fbfa817`. Compose·기존 image·최소 데이터 digest/count·source·FE archive 포함. dump는 OCI에만 보관한다.
- 초기 후보 `31f3925`는 source preparation 단계에서 후속 수정으로 대체되었으며 runtime으로 승격하지 않았다.

## 실제 배포 및 공개 검증 완료

- OCI 기존 Compose의 backend image만 위 digest로 변경, `up -d --no-deps --no-build --pull never backend`. DB/tunnel 재생성 없음. 신규 컨테이너 `SELECT 1`, 내부 health, 공개 HTTP200 및 `X-Release-Sha`/JSON `commitSha`/`releaseId` 모두 source SHA와 정확히 일치.
- Pages production deployment **`0e2ad67f-4a64-47de-9b5b-d326877075d3`**, created `2026-10-04T17:02:55.845545Z`, success, `ad_hoc`, branch main, clean commit `e44808e28da2f9d91b1b50bd41ed6cb0f079f786`. project source null/direct-upload 유지. GitHub Actions 배포로 주장하지 않는다.
- `2026-10-04T17:04:56.661Z` 공개 검사: API header/body와 `https://living-cost-manager.gamja.top/release-meta.json`, `https://living-cost-manager.pages.dev/release-meta.json` 모두 동일 SHA/releaseId.
- canonical guide **5개 HTTP200**: `/guide/`, `/guide/billing-dates/`, `/guide/renewal-checklist/`, `/guide/backup-and-sync/`, `/guide/faq/`. 각 단일 h1/canonical/JSON-LD; dashboard noindex, 없는 guide404. slash 없는 경로는 정상 canonical308 리다이렉트이므로 canonical URL을 검증했다.
- 운영 Chromium **1440/390**: 빠른 입력 preview/IME, 새 행 포커스, 갱신 queue, 복제, 필터, 삭제취소, quota→미저장 export→재시도, import 검증/취소/적용, 모바일 접근성, reload 보존 통과. runtime error/가로 overflow 없음.
- 추가 운영 390/1440 회귀: `filter-2`, ISO 날짜 이름, `.5개월` preview/추가, 붙여 쓴 음수 금액 거부 통과. screenshots: 승인 임시 루트 `lcm-usability-release/review-{390,1440}.png`.
- 모든 운영 브라우저는 새 context의 로컬 데이터만 사용, 서버 write 차단. Cloudflare가 삽입하는 `static.cloudflareinsights.com` beacon도 차단한다. 최초 검증의 예상 밖 beacon/비canonical308은 harness 조건을 실제 운영 경로에 맞춰 수정 후 재검증했다; 제품 오류로 숨기거나 고객 데이터로 우회하지 않았다.
- 독립 reviewer M1–M6 통과; 최종 Astra reviewer가 exact tree 확인 및 web131/shared92 독립 재실행 후 blocker 없음. 동일 tick 복구 보존 변경도 별도 reviewer가 회귀 재실행 후 통과.
- 공개 E2E harness의 method 검사를 analytics 예외보다 앞에 배치한 후 운영 1440/390 재실행 및 독립 최종 review 통과. 이 후속 변경은 검증 스크립트/문서에만 적용하며 배포된 앱 source SHA는 그대로다.
- 기존 FixedCost full-row digest/count 및 User count 전후 동일. dump checksum 재확인 성공, reminder timer active, backend `unless-stopped`. 고객 계정 생성/메일/푸시 없음.
- gamja-ops 최신 LCM release branch 기반 별도 worktree에서 runbook 증거 갱신; asset validation 통과. local-drift는 기존 퇴역 Mac LaunchDaemon/백업 경로 및 다른 서비스 기록 때문에 실패하며 이번 배포와 분리된 기존 registry 정리 과제다.
- Ops 증거 commit `987e6fa`, 원격 branch `docs/lcm-usability-20261005`에 push 완료. Ops main에 병합되었다고 주장하지 않는다.
- 임시 PostgreSQL/API/web/브라우저 종료, 목적 전용 verification cluster 제거. 운영 registry 임시 인증은 logout 완료. 기존 dirty 원본 checkout은 보존했다.

## 열 가지 완료 항목

1. 브라우저 저장 상태·실패 재시도·미저장 export
2. 검색·필터·정렬
3. 항목 복제
4. 삭제 취소
5. 빠른 입력 검증·미리보기
6. 모바일 터치·키보드 포커스·접근성
7. 청구 일정 설정 및 소수 주기 안내
8. 갱신 검토 작업 목록
9. 가져오기 검증·미리보기·복구 보존
10. 단일 명령 격리 full-stack 검증 DX

위 열 가지 모두 같은 source SHA의 FE/API로 배포 완료했다.
