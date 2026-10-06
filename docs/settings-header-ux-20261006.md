# 사용 통계 설정과 전체폭 헤더 — 2026-10-06

## 고객 결과 / 현재 근거

메인 헤더를 가계부 작업에 집중시키고, 선택적 통계 제공의 목적/범위/철회를 데이터 관리에서 이해하고 선택할 수 있게 한다. 고객 요청에 따라 동일 `lcm-billing` 작업트리에서 결제 준비 커밋 `3794fc0` 이후 독립 UX 커밋으로 진행한다. 기존 원본 dirty checkout은 그대로 보존했다.

원래 UI에는 `page-shell` 안에서 `MarketingConsentControl`이 헤더보다 먼저 렌더링되었다. '선택적 중앙 집계'는 목적을 설명하지 못했다. 헤더 shell의 100%는 부모의 제한폭 기준이어서 전체 viewport border가 아니었다. 원래 작성자의 의도나 floating 창을 생략한 법적 이유는 확인되지 않았다.

## 변경

- `page.tsx` / `AppHeader.tsx` / `globals.css`: semantic header를 제한폭 main 밖에 배치. outer 배경·border는 화면 전체, inner는 main과 동일 최대폭/모바일 여백. 콘텐츠 자체를 화면 끝까지 늘리지 않는다. 기존 wrapping/색상 모드/저장 오류 안내 유지.
- `DataModal.tsx` / `MarketingConsentControl.tsx`: 기존 '데이터 관리' 한 번 클릭으로 접근하는 첫 '개인정보와 사용 통계' 섹션으로 이동. 별도 강제 floating/banner/modal은 만들지 않았다. 이런 UI 선택이 법적 의무 없음의 판단을 뜻하지 않는다.
- Label `서비스 개선을 위한 사용 통계 제공(선택)`. 기본 OFF·선택하지 않아도 이용 가능·새 저장 사실만 제공·금액/항목명/이메일/계정ID 제외·기존 기록 미업로드를 먼저 설명. UTC 일별 합계 최대90일/운영자 확인/중복과 사람 수의 차이/철회 후 불가역 합계/접속 메타데이터는 details에서 설명. '익명'이나 법적 준수 보장은 하지 않는다.
- `AnalyticsDashboard.tsx`: `개인 기기에서 확인하는 통계`로 용어 정리. 아래 기기 통계는 별도 local IndexedDB 기록이며 opt-in이 이를 업로드하지 않음을 명시.
- `useMarketingConsent.ts`: 기존 상태/차단/철회 listener를 **page lifetime hook**으로 이동. UI modal이 닫혔다고 broadcast/storage/focus/GPC/DNT/inflight abort가 사라지지 않도록 한다. 새 수집 필드/전송 이벤트/보존기간/consent key를 만들거나 기존 동의를 reset하지 않았다. ordinary user용 operator API도 추가하지 않았다.

## 검증 계약

- 기존 consent control unit tests는 새 page hook과 실제 control 연결을 대상으로 그대로 유지. 별도 test로 settings UI를 렌더링하지 않은 상태에서도 cross-tab storage revocation이 진행 중 fetch를 abort함을 확인.
- 기존 13 privacy browser 시나리오는 **실제 데이터 관리 열기 → 설정 조작 → 닫기 → 가계부 동작**으로 적응. default-off/저장 실패/GPC/DNT/철회/동시 탭/진행 요청 중단/과거 기록 미전송 assertion을 제거하지 않는다.
- consent scenario에서 1440/390 outer header left=0·width=viewport, border=1px, inner/main 위치·폭 일치, overflow=0, header checkbox 없음, Enter로 관리 열기·checkbox focus·Escape 종료 후 trigger focus 복원 검증.
- 실제 로컬 API sync E2E의 오래된 `header.app-header` selector는 새 semantic banner로 변경했으며 sync·충돌·계정 삭제 등의 assertion은 그대로 유지했다.
- 그림 증거는 `verify-marketing --scenario consent --screenshots <approved directory>`로 새 빈 로컬 profile만 촬영한다. main/사용자 browser extension이나 KCP 탭은 조작하지 않는다.

## 남은 상태

실제 과금 OFF. 새 프로덕션 설정/DB/env/provider 변경 없음. 독립 reviewer/security 검토와 운영 배포는 메인 조정자 후속이다. 이 UX 커밋은 noncharging으로 별도 리뷰·우선 배포 가능하지만 FE/BE 같은 SHA와 배포 runbook은 유지한다. 현재 운영은 기존 가격 준비 배포이며 이번 소스 변경을 운영 완료로 보고하지 않는다.

## 이번 실행 결과

- `LCM_TEST_TEMP_ROOT=<approved temp root> PG_BIN=/opt/homebrew/opt/postgresql@16/bin pnpm verify:usability` 최종 통과. Application **507** (shared 115 / web 210 / API 182), operator 17 / ownership 2 / service worker 3 별도. 기존 469 + billing 37 + closed-settings privacy test 1이며 단계별 결과를 합쳐 중복 계산하지 않는다.
- API/web production builds, 1440/390 usability/layout/keyboard/focus 복원, 실제 로컬 API sync/conflict/relogin/account 삭제, 기존 **13 privacy browser 시나리오**, 가격/준비 안내와 JS 없는 static HTML 검증 통과.
- 최종 로그 `<approved temp root>/lcm-billing-settings-verify-reviewed.log`. 파일명의 reviewed는 자체 수정 후 재검증 이름일 뿐 **독립 reviewer 검토를 뜻하지 않는다**.
- 최초 실행은 기존 component test harness의 prop 계약 변경에서 실패했고, 다음 실행은 sync E2E의 옛 header selector에서 실패했다. 테스트 연결/selector만 적응하고 기존 assertion을 유지한 후 최종 전체 재실행으로 통과했다. 이전 실패 로그 `lcm-billing-settings-verify.log`, `lcm-billing-settings-verify-final.log`도 보존.
- 별도 `node scripts/verify-marketing.mjs --serve apps/web/out --scenario consent --screenshots <approved temp root>/lcm-settings-screenshots` 재실행 통과. 1440/390 header/settings PNG 직접 확인. 스크린샷은 fake clock에 정지된 transition을 완료시키는 Playwright `animations: disabled` 옵션으로 생성한 빈 로컬 테스트 profile이다.
- 임시 PostgreSQL cluster 삭제 및 모든 verification server 종료 로그 확인. API mutation/marketing POST는 browser privacy harness에서 전부 가로채고 외부 통신을 차단했다. production DSN/고객 데이터 미사용, main browser/KCP 탭 미조작.
- `git diff --check` 통과. 독립 리뷰/배포는 미실행이다.
