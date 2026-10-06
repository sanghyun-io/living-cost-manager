# 포지셔닝과 기능 근거

## 검증 전 가설
- **H1 타깃:** 한국어 사용자 중 연간 구독을 포함한 여러 개인 구독을 직접 정리하고, 최근 갱신 확인에 어려움을 겪은 직장인. 모든 가계부 사용자나 팀 재무 담당자로 넓히지 않는다.
- **H2 문제:** 총지출 합계보다 “다음 청구가 언제이며 유지할지”를 함께 기록하는 일이 더 시급할 수 있다.
- **H3 가치:** 자동 연동 없이 직접 입력하더라도 결제 기준일·다음 행동을 한곳에 정리할 가치가 있을 수 있다. 입력 부담이 더 크다면 기각한다.
- **H4 가격:** 2026-10-06 준비 기준은 월 990원 / 연 9,900원이며 과거 월 2,900원 가설을 대체한다. 현재 구매 가능한 상품이 아니다. 부가세 포함 가정·PG/법률/세무 게이트와 구현/배포 상태는 [가격/결제 준비 기록](../payment-readiness-20261006.md)을 따른다. 공개 카피는 반드시 준비 중·결제 비활성을 함께 표시한다.

## 확인된 기능 목록
확인 범위: 2026-10-05 저장소 코드/가이드와 기록 대조. 운영 상태는 아래 릴리스 기록에 한정하며 새 실사용 성과가 아니다. 경로는 저장소 루트 기준이다.

| 기능 사실 | 제한 / 카피 주의 | 코드·문서 출처 |
|---|---|---|
| 로그인 없는 로컬 대시보드, 별도 샘플 공간 | 브라우저 저장; 기기 간 자동 복원/보안 잠금 아님 | `apps/web/app/guide/page.tsx:15–38`; `apps/web/app/lib/useLocalUsers.ts`; `docs/pm-implementation-verification.md:13` |
| 기준일·주기로 다음 결제 계산, 월환산과 30일 실제 예정 청구 구분 | 직접 입력 기준 계산; 실제 청구 검증 아님. 기준일 누락/소수 개월은 일정 미확인 | `packages/shared/src/predictions.ts:33–127`; `apps/web/app/guide/content.ts:11–35` |
| 유지·해지 예정·변경 검토·완료 기록 | 외부 구독 해지/결제 차단 없음 | `packages/shared/src/billing.ts:9–23`; `apps/web/app/components/FixedCostTable.tsx:350`; `apps/web/app/guide/content.ts:40–60` |
| 예상 절감과 직접 확인 절감 분리 | 사용자 기록이며 은행 검증·환불·보장 실적 아님 | `packages/shared/src/billing.ts:15–23`; `apps/web/app/guide/content.ts:55–56` |
| 백업·가져오기, 수동 기준본 후 선택적 자동 업로드 | 열린 페이지에서만; 새 세션 기본 off, 충돌 시 중단. 자동 병합/양방향 백그라운드 동기화 아님 | `apps/web/app/lib/useWorkspaceSync.ts:142–145`; `apps/web/app/guide/content.ts:65–85`; `docs/pm-implementation-verification.md:14–15` |
| 빠른 입력 미리보기·복제·검색/필터·삭제 취소·갱신 검토 목록 | 실제 고객의 편의/성공률은 미측정 | `apps/web/app/components/FixedCostTable.tsx:173,238`; `docs/usability-release-20261005.md:46–59` |
| 공개 가이드 5개, canonical·구조화 데이터, 대시보드 noindex | 검색 노출·순위·검색 수요의 증거 아님 | `apps/web/app/sitemap.ts:7–8`; `apps/web/app/guide/[slug]/page.tsx:24–38`; `docs/usability-release-20261005.md:35` |

릴리스 기록: [2026-10-05](../usability-release-20261005.md) 및 [2026-10-03](../production-release-20261003.md). 고객 가치 미검증 근거: [PM 계획](../pm-subscription-readiness.md), [구현 검증](../pm-implementation-verification.md). 로컬/운영 테스트 통과는 인터뷰·유료 수요·절감 성과를 입증하지 않는다.

## 내부 검토용 카피 — 아직 게시하지 않음
**제목:** 연간 구독, 다음 결제 전에 유지할지 정리하세요

**본문:** 구독의 금액과 청구 기준일을 직접 등록하고, 월환산 비용과 향후 30일 예정 청구액을 나눠 확인하세요. 유지·해지 예정·변경 검토를 기록해 다음 행동을 정리할 수 있습니다. 실제 해지는 해당 사업자에서 진행해야 합니다.

**CTA:** 먼저 가상 구독 한 개로 정리해 보기 → 기존 대시보드 https://living-cost-manager.gamja.top/

보조 안내: 로그인 없이 로컬 기능으로 시작할 수 있습니다. 브라우저 데이터를 지우기 전에는 백업하세요.

톤: 전문적이되 친근하게, “등록·확인·기록” 같은 실제 행동 중심. “자동 절약”, “절감 보장”, “완전 익명 서비스”, “은행 자동 연동”, “자동 해지”, 알림 수신 보장, 확인되지 않은 경쟁 우위·가격 비교는 쓰지 않는다. 경쟁사 조사는 이번 범위에서 생략했다.
