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

배포 완료 증거는 실제 실행 후 별도 문서 commit으로 추가한다. 이 문서의 사전 검증만으로 배포 완료를 주장하지 않는다.
