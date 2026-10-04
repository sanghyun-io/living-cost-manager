# 사용성 개선 실행 백로그

기준 source `550686b`, 운영 FE/API `b9aee691b09662849f5cca3a3690d0e3c32d3130`. 기존 기준일/30일 예정/검토 상태/안전 동기화를 신규 기능으로 집계하지 않는다.

실제 desktop/mobile 감사 스크린샷: OpenCode 임시 루트 `lcm-usability-audit/{desktop-01-initial,mobile-01-initial,wf-07-data-modal,wf-05-delete-mode}.png`. 코드 근거는 `FixedCostTable.tsx`, `useBudgetData.ts`, `AppHeader.tsx`, `DataModal.tsx` 및 루트 package scripts. 감사의 추정사항(알림 없음, FastAPI 등)은 채택하지 않는다.

아래 순서대로 구현하며 각 완료 시 결과/검증/commit을 기록한다. 새 DB schema 없이 기존 값과 사용자 경계를 보존한다.

| 순서 | 우선순위 / 기능 | 사용자 문제와 가치 | 선행 | 수락조건 / 의미있는 검증 | 상태 |
|---|---|---|---|---|---|
| 1 | P0 저장 상태 및 실패 재시도 | 로컬 저장과 서버 저장 혼동, quota 실패 후 복구 어려움 | 없음 | 브라우저 저장임을 명시, 실패 재시도와 미저장 데이터 내보내기; 저장 실패 주입 후 복구 확인 | 대기 |
| 2 | P1 검색·필터·정렬 | 카테고리만으로 많은 항목 탐색 불가 | 1 | 이름/결제수단/검토 상태 조합, 금액·납부일 정렬, 초기화와 빈 결과; 조합/미확인 날짜 테스트 | 대기 |
| 3 | P1 항목 복제 | 비슷한 항목 반복 입력 부담 | 2 | 새 ID, 청구 정보 보존, 검토/절감 초기화, 복제본 노출; 원본 불변 테스트 | 대기 |
| 4 | P0 삭제 취소 | 삭제 실수를 즉시 복구 불가 | 3 | 최근 삭제 복원, 후속 편집 보존, 프로필/가져오기 경계 무효화; 데이터 손실 회귀 | 대기 |
| 5 | P1 빠른 입력 미리보기 | 해석 결과와 실패를 제출 전 파악 불가 | 4 | 이름/금액/주기 미리보기, 유효하지 않으면 입력 보존, IME Enter 안전; 파싱/실패 브라우저 검증 | 대기 |
| 6 | P1 모바일·키보드 편집 | 작은 터치영역, 새 행 포커스와 모달 이름 부족 | 5 | 새 항목 포커스, 건너뛰기, 이름 있는 닫기/파일 입력, 모바일 터치/overflow 검증 | 대기 |
| 7 | P1 일정 설정 안내 | 기준일·소수 주기 미확인 원인 모름 | 6 | 미확인 이유와 수정 방법, 실제 청구액/월환산 구분, 월말 안내; 윤년·소수 주기 회귀 | 대기 |
| 8 | P1 갱신 검토 작업 흐름 | 목록 전체에서 임박·미결정 항목 찾기 어려움 | 7 | 임박 미검토/해지예정/변경검토 중심 작업목록과 직접 편집 이동, 실제 절감 과장 없음; 상태 전이 검증 | 대기 |
| 9 | P0 가져오기 검증·미리보기 | 교체 전 내용과 영향 파악 불가 | 8 | 파일 검증 후 현재/대상 개수·금액 확인과 명시 적용/취소, 파일 읽기/프로필/편집 경쟁 방지; 손상/취소/경쟁 테스트 | 대기 |
| 10 | P1 one-command 검증 DX | 격리 테스트와 브라우저 회귀 실행 경로 분산 | 9 | 문서화된 단일 명령, DB loopback/test guard, finally 서버/DB 종료, 실패 exit 전파; 실제 실행 확인 | 대기 |

## 완료 게이트

### 구현 체크포인트 (현재 요청 범위: 로컬 구현/검증만)
- 5 완료 — 파싱 미리보기/기본 매월 명시, 누락·범위 오류 입력 보존, IME Enter 차단. quickAdd + budgetUsability 4/4 통과. 브라우저 IME 검증은 10번 통합 명령에 포함. commit: `feat(usability): preview and validate quick entry`.
- 4 완료 — 최근 삭제 병합 복원, 후속 편집 보존, 프로필 로드/스냅샷 교체/가져오기 무효화, 삭제된 참조 보정. budgetUsability 2/2 통과. 연속 추가 ID 충돌도 UUID로 해결. commit: `feat(usability): undo deletion without reverting subsequent edits`.
- 3 완료 — UUID 복제, 청구 필드 보존/검토·절감 초기화, 필터 해제로 복제본 노출. costViews 3/3 통과, 원본 불변 검증. commit: `feat(usability): duplicate costs with fresh review state`.
- 2 완료 — 이름/결제수단/검토 조합, 실제 청구금액/납부일 정렬, 초기화/빈 결과. costViews + budgetUsability 3/3 통과. commit: `feat(usability): combined cost search filters and sorting`.
- 1 완료 — 브라우저 저장 표시, quota 재시도, 현재 메모리 백업. `budgetUsability` 1/1 통과 (quota 실패→최신 수입 복구, 프로필 쓰기 차단). commit: `feat(usability): retry browser storage and export unsaved data`. shared 선행 build 필요 확인.

각 기능 테스트와 checkpoint commit → 전체 shared/web/API 테스트 및 build → Chromium desktop/mobile → 별도 reviewer 및 모든 blocker 수정 → latest main 안전 통합 → 기존 OCI digest-pinned/Pages direct-upload runbook으로 배포 → 공개 SHA/브라우저 검증 → 임시 자원 종료. 운영 DB reset/drop 금지. 고객 알림 금지. 기존 dirty 원본 worktree 보존.
