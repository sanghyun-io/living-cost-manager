# PM 우선순위 구현·검증 기록

> 아래는 로컬 구현 당시 기록이다. 이후 승인된 운영 배포와 332개 테스트·실서비스 검증은 [2026-10-03 운영 배포 기록](./production-release-20261003.md)을 따른다.

계획/수락 조건: [pm-subscription-readiness.md](./pm-subscription-readiness.md)

## 로컬 구현 완료

- `packages/shared/src/billing.ts`, `predictions.ts`: 기준 날짜에 고정한 월/분기/연간 반복, 말일·윤년 보정, 과거 기준일에서 다음 회차 계산. 기준일 누락 또는 소수 개월 주기는 일정 미확인. 알림 대상에서 제외한다.
- `prisma/schema.prisma`, `prisma/migrations/20261003000000_billing_anchor_renewal/migration.sql`, `apps/api/src/services/snapshot.ts`, `jobs/send-due-reminders.ts`: 기준일·갱신 상태·예상/확인 절감액을 DB/API/알림에 반영했다. **운영 마이그레이션은 적용하지 않았다.** 마이그레이션 실행 검증은 이번 작업에서 만든 임시 로컬 DB에 한정했다.
- `apps/web/app/lib/{budget,backup,budgetImportExport,snapshot,storage}.ts`: 로컬/CSV/LCM/API 왕복 보존, 기존 데이터 호환, 잘못된 날짜 및 잘린 가져오기 파일 거부.
- `FixedCostTable.tsx`, `InsightsPanel.tsx`, `page.tsx`: 기준일 편집, 다음 결제일, 실제 30일 청구액과 월환산 구분, 유지/해지 예정/변경 검토/완료, 예상 절감과 직접 확인 절감 분리. InsightsPanel을 실제 페이지에 연결했다.
- `useLocalUsers.ts`, `users.ts`: 빈 공간 시작, 별도 샘플 공간, 원래 공간으로 복귀, 기존 사용자 덮어쓰기 방지, 이전 이름 기반 프로필의 저장 키를 유지하면서 서버 ID를 연결한다.
- `useBudgetData.ts`: 사용자별 hydration/save 경계, 늦은 파일 읽기 무효화, 교체 전 백업, 복구본 내보내기, 손상 원본 자동 덮어쓰기 금지 및 원본 JSON 내보내기.
- `useWorkspaceSync.ts`, `syncSafety.ts`: 수동 기준본 합의 후 명시적으로 켜는 자동 업로드, 계정/로컬 사용자/워크스페이스 scope 분리, 버전 충돌 시 중단, 응답 대기 중 수정 보존, 서버 불러오기 전 복구본 확인. 자동 업로드는 페이지가 열린 동안만 동작하며 새 세션에서는 기본 꺼짐이다.
- `useServerAuth.ts`, `account.ts`, `analytics.ts`: 이전 미커밋 구현의 계정 삭제·인증 응답 경쟁·개인정보 최소화 결함을 수정했다. 삭제는 서버 ID로 대상 로컬 프로필을 정하며 다른 계정을 지우지 않는다. 다른 열린 탭의 예산/대기 analytics 재생성을 tombstone/삭제 세대로 차단한다.
- 카드 대금 결제일은 구독 사업자의 청구일과 별개인 참고 정보로 명시했다. 카드 변경으로 구독 기준 날짜나 말일 설정을 자동 변경하지 않는다.

## 검증 결과

| 검증 | 결과 |
|---|---|
| shared Vitest | 9개 파일, 92개 테스트 통과 |
| web Vitest | 9개 파일, 113개 테스트 통과 |
| API Vitest | 12개 파일, 120개 테스트 통과 |
| 전체 workspace production build | shared/API/web 통과, 정적 페이지 생성 성공 |
| web TypeScript | `tsc --noEmit --incremental false` 통과 |
| diff whitespace check | `git diff --check` 통과 |
| Chromium 로컬 여정 | `scripts/pm-local-e2e.mjs` 통과 |
| Chromium + 실제 격리 API | `scripts/pm-sync-e2e.mjs` 통과 |

API 테스트는 새 임시 PostgreSQL 클러스터(`127.0.0.1:55483`, DB/schema `lcm_test`)에서 실행했다. 기존 로컬 PostgreSQL 및 OCI에 연결하지 않았다. 테스트 리셋 가드는 명시적 `API_TEST_DATABASE_URL`, loopback host, 테스트 DB명과 테스트 schema를 모두 요구하며 `DATABASE_URL`로 fallback하지 않는다.

브라우저 검증은 기존 설치된 Playwright/Chromium을 사용했다. 새 브라우저 context만 사용했고 외부 origin 요청을 차단했다. 실제 API 여정은 로컬 `127.0.0.1:4318` API와 `127.0.0.1:3318` 웹만 허용했다. 테스트용 계정만 생성/삭제했으며 메일은 console provider였다. 테스트 서버와 임시 DB는 검증 후 종료했다. CI 또는 staging을 상시 활성화하지 않았다.

### 실제 브라우저 검증 내용

1. 빈 상태 → 빠른 연간 구독 등록 → 일정 미확인 → 기준일 입력 → 월환산이 아닌 30일 전체 청구액 표시.
2. 샘플 왕복 시 내 데이터 보존, 갱신 해지 예정 → 실제 해지 확인 → 확인 절감 기록 → 새로고침 보존.
3. 전체 백업 내보내기, 파일 읽기 중 사용자 전환 시 늦은 Import 미적용.
4. 손상 원본 + 복구 사본 quota 실패 주입 시 원본을 덮어쓰지 않고 그대로 내보내기.
5. 실제 API 로그인 → 수동 업로드 → 자동 업로드 → 다른 클라이언트 버전 수정 → 409 충돌 후 양쪽 데이터 보존.
6. 서버 데이터 명시적 불러오기 및 복구본 보관, GET 대기 중 로컬 편집을 늦은 응답으로 덮어쓰지 않음.
7. 서버 프로필의 샘플 왕복과 재로그인, 실제 테스트 계정 삭제, 다른 탭의 대기 analytics/예산 재생성 차단, 삭제 후 샘플 왕복으로도 삭제된 프로필 복원 금지.

스크립트 재실행 시 `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE`로 설치된 로컬 도구 경로를 지정할 수 있다. `pm-sync-e2e.mjs`는 위의 격리 DB/포트를 강제 검사한다. 사용자 운영 경로나 URL을 추정하는 용도로 사용하지 않는다.

## 독립 리뷰와 수정

별도 읽기 전용 reviewer 세션들이 기존 미커밋 계정 삭제/리팩토링/analytics와 이번 결제/동기화 변경을 검토했다. 발견한 기존 사용자 덮어쓰기, 늦은 인증/동기화/Import 응답, 잘못된 삭제 대상, analytics 삭제 후 재생성, legacy 프로필 접근 단절, 샘플 복귀 오류, quota 실패 시 원본 손실, 잘린 파일 허용, 빈 서버 동기화 복구 경로, 부분 로그인 계정 혼합을 수정했다. 마지막 발견인 다른 탭의 삭제 후 샘플 왕복 재생성도 수정하고 실제 브라우저 회귀 시나리오로 통과시켰다.

## 운영·제품의 남은 검증

- **운영 배포 없음. 프로덕션 DB 변경 없음. 운영 검증 완료를 주장하지 않는다.** 기존 dirty infra/README/배포 파일을 운영 근거로 사용하거나 추가 수정하지 않았다.
- FE Cloudflare / BE·DB OCI 배치는 유지한다. 배포 단계에서는 최신 gamja-ops 위치와 실제 설정, 마이그레이션 승인, 구버전 클라이언트와의 호환/롤백, 알림 스케줄러 실행 시간대 및 전달을 확인해야 한다.
- 실제 고객 관찰과 10~20명 베타 모집·재방문·지불 의향은 아직 수행되지 않았다. 당시 월 2,900원은 과금하지 않은 역사적 가설이며, 2026-10-06 월 990원 / 연 9,900원 준비 기준으로 대체됐다. 실제 결제는 OFF이며 현재 상태는 [결제 준비 기록](payment-readiness-20261006.md)을 따른다.
- 온디바이스 analytics는 개인정보 필드를 제거해 로컬에 저장하지만 운영자가 전환율을 볼 수 있는 중앙 측정은 아니다. P2 운영 측정의 수집/동의/보존 설계는 계획 상태다.
- 기기 간 자동 병합·백그라운드 양방향 동기화는 구현했다고 주장하지 않는다. 현재는 명시적 기준본과 버전 검사에 기반한 자동 업로드 및 수동 충돌 해결이다.
