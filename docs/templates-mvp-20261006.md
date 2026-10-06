# 고정비 설계도 템플릿 MVP — 2026-10-06

## 목표와 경계

제작자가 반복 지출 항목의 틀을 직접 만들고, 독자가 금액을 채워 새 생활비 공간에 적용한다. 첫 가치단위는 상황별 3개 시작점 / 나만의 계정 저장·수정·삭제 / 명시적으로 검토한 설계도 게시·미리보기·복사·철회이다. 범용 엑셀 수식·변동 지출 가계부·판매 결제·제작자 정산은 구현하지 않는다. 제작자 유입·지불 의사·매출은 미측정이다.

UI 리뷰 freeze `9eafeee`를 보존하고 별도 branch `feat/templates-20261006`, worktree `lcm-templates`에서 진행한다. 원본 dirty checkout의 planner 문서는 제안이며 수정·이동·삭제·포괄 commit하지 않는다. 프로덕션 DB 변경은 이 작업의 코드 구현 승인으로 자동 승인되지 않는다.

## 데이터 계약

설계도 `title,description,authorLabel,items[{name,category,periodMonths}]`만 strict schema로 허용한다. **계정/원본 ID, 금액/수입, 카드 별명·결제일, 기준 납부일/말일, 메모/히스토리, 갱신 상태·예상/확정 절감**은 모든 깊이에서 거절한다. unknown key를 조용히 제거하지 않는다. 현재 재무 데이터를 설계도로 자동 추출하지 않는다. 작성자가 공개할 문구를 별도 편집한다.

최대40항목, 이름80자, 설명600자, 정수1~120개월, 요청100KiB, 계정당20개. 흔한 이메일/링크/긴 숫자/제어 문자 패턴은 거절하지만 모든 개인정보를 자동 판별하거나 익명화한다고 보장하지 않는다. 자유 문구가 공개된다는 경고와 실제 미리보기·개인정보 검토·공유 권한 확인이 필수다. React 텍스트 렌더링으로 escape하며 HTML·외부 링크·이미지를 실행하지 않는다.

금액 미입력은 0원이 아니다. 적용 전 **모든 항목의 실제 청구 금액과 수입을 직접 입력**해야 한다. 실제 0은 명시적으로0을 입력한다. 값은 브라우저 적용에만 쓰며 저장·게시 API에 보내지 않는다. 새 category/item/profile ID, 카드 없음, 납부 기준일 미확인, 검토 초기화, 절감0. 따라서 입력하지 않은 날짜를 예정 결제로 꾸미지 않는다.

## 지속 저장과 권한

추가 테이블은 두 개다:

- `BudgetTemplate`: User 소유 private JSON 설계도, 낙관적 revision. Workspace와 연결하지 않아 공동 생활비 편집 권한을 공개 설계도 권한으로 오해하지 않는다.
- `BudgetTemplateShare`: template당 최대1개의 pinned JSON 게시본, 무작위32byte token,90일 조회 만료, revokedAt(레거시 행용). 별도 draft edit는 기존 게시본에 영향을 주지 않는다. 다시 게시하면 token이 바뀌어 이전 링크가 즉시 무효다. **명시적 철회는 게시본 행(token+text)을 owner transaction 안에서 물리 삭제**하고 이후 GET을 거부한다(재실행 204 idempotent). 초안은 어떤철회·만료정리에도 보존되며 owner 삭제/계정 삭제(cascade)로만 사라진다. 90일 이후 조회 거부는 보장, 물리 소각은 owner 활동·공개 조회 시점의 기회적(정확한 날짜 보장 아님 — 완전삭제 문구 금지). 이미 복사된 데이터는 원격 삭제하지 않는다.

저장/수정/게시에는 인증+확인된 이메일을 요구한다. 목록/삭제/철회는 인증된 소유자만. User 행을 transaction 안에서 잠가20개 quota와 revision/publish/revoke/delete 경쟁을 직렬화한다. private owner ID는 public DTO에 절대 넣지 않는다. 공개 목록·검색·crawler route 없음.

API: `/templates`, `/templates/:id`, `/templates/:id/publish`, `/templates/:id/share`, `/template-shares/:token`. 게시 조회는 `no-store`, 모두 `X-Robots-Tag: noindex,nofollow`; 쓰기는 검증된 JWT `sub`당 60회/분(인증 성공 후 preHandler 순서 보장), 공개 조회는 (client, token)당 30회/분 + 스윕 계층 — 프록시 체인 read-only 검증 전에는 `TRUST_PROXY=off` 기본으로 익명 per-client 분리를 주장하지 않는다. 템플릿 경로의 자동 요청 로깅을 억제한다. **CDN/proxy access log 보존·redaction까지 검증했다고 주장하지 않으며 운영 적용 전에 점검한다.** 상세: [보안 리뷰 대응](templates-security-20261006.md).

CF 정적 export는 기존 루트 `/#template=<opaque-token>`로 읽는다. 주소에 금융 JSON을 넣거나 runtime slug 페이지를 생성하지 않는다. public GET만으로 조회하며 API+클라이언트 모두strict schema; public 응답100KiB / private 목록512KiB 스트림 cap. 외부 요청·새 analytics event·새 의존성 없음. API는 기존 도메인·prefix·port를 사용한다.

## 적용 안전

기존 금융 storage key에는 쓰지 않는다. 새 snapshot을 별도 random profile key에 저장한 다음 user registry와 active pointer를 바꾼다. 쓰기 실패 시 우리 새 공간과 변경 registry만 복원한다. 기존 byte는 유지된다. 새 profile의 private return pointer로 reload 후에도 원래 공간으로 돌아간다. 다른 계정/삭제된 profile의 데이터는 불러오지 않는다.

미저장 오류/복구 필요 상태에서는 적용을 막는다. 서버 연결 중이라면 명시적인 연결 해제 확인을 요구하고, 새 profile의 데이터/registry 준비가 성공한 뒤 기존 연결·동기화 scope를 끊고 새 active pointer를 발행한다. 기존 자동 동기화로 새 설계도가 원래 workspace에 업로드되지 않도록 한다. 연결 해제나 pointer 저장에 실패하면 기존 금융 데이터는 보존되지만 명시적으로 해제한 로그인은 복원되지 않을 수 있으며 오류를 표시한다. 계정 전환 시 private editor/list를 비우고 응답 scope를 검사한다. 공유 조회는 AbortController로 최신 fragment만 사용한다. 공개 링크에서 적용할 때는 서버 재조회해 철회·만료를 확인한다.

## 프로덕션 승인 gate (미실행)

추가 migration `20261006160000_budget_templates`는 기존 테이블/열을 변경하거나 데이터를 변환하지 않는다. User FK/cascade 때문에 메타데이터 잠금·DDL timeout 영향은 실제 DB/트래픽 조건에서 사전 점검해야 하며 무중단을 보장하지 않는다.

1. 메인 independent reviewer/security 검토와 적용 대상·두 테이블·공개 데이터 목적/보존 정책에 대한 명시적 Owner 승인.
2. 실제 최신 OCI/registry image/Compose/env hash/FE release를 확인. 현재 runbook과 gamja-ops registry의 데이터 목적·백업/보존 범위 점검. 기존 dirty AGENTS의 오래된 도메인/자동 Actions/SSH 정보로 운영을 되돌리지 않는다.
3. 보호된 기존 DB 백업과 복원 가능성 확인, isolated rehearsal 근거 확인. 실제 고객 DB 덤프를 개발 Mac에 복사하지 않는다. 적용 전 approved backup 위치/권한/TTL 확인.
4. 새 코드 deploy 전 additive migration을 제한된 maintenance window/lock timeout 정책으로 적용. 확인된 permission/schema owner를 유지하고 unrelated service를 재시작하지 않는다.
5. 먼저 새 API, 그 후 정확한 FE artifact로 단계 적용. owner/cross-account/private/public revoke/cache 및 기존 auth/sync/pricing/privacy 공통 smoke 확인.
6. 롤백은 이전 API/FE image로 복귀하고 **새 테이블은 그대로 보존**한다. `DROP TABLE`, migration reset, 과거 DB 복원으로 새 작성자 데이터를 없애지 않는다. 새로운 표면을 비활성화해도 저장본을 보존하고 후속 복구 여부를 Owner가 판단한다.

로컬 restore rehearsal은 전용 test cluster의 synthetic schema를 `pg_dump`/`pg_restore`로 별도 DB에 복원하고 기존 User 필드와 새 두 테이블을 확인한 뒤 제거한다. **실제 프로덕션 백업/복원 리허설의 대체가 아니다.**

## 검증 상태

최종 `pnpm verify:usability` PASS: shared136/web218/API239, 총593개. API 권한·교차 계정·revision 충돌·동시 quota·게시본 고정·재게시·철회·만료·계정 cascade·payload cap·공개 rate limit을 실제 격리 PostgreSQL에서 확인했다. 이후 보안 리뷰 대응(B1/N1/N2/B4/B5/C10)으로 shared158·API251 재검증 — 근거와 미완료 게이트는 [templates-security-20261006.md](templates-security-20261006.md) 참조.

템플릿 브라우저1440/390/360 PASS: 상황별3개 선택, 확인된 계정의 저장/비공개 사용, 미리보기/명시적 게시, anonymous 조회, 미입력 금액 차단, 새ID/새profile, 기존 snapshot byte 보존, reload 후 원래 공간 복귀, 철회/삭제, 명시적 연결 해제와 기존 workspace 업로드0, 통계 동의ON 상태에도 템플릿 등록 이벤트0. HTML처럼 보이는 작성 문구가 텍스트로만 표시되고 실행되지 않음을 확인했다. 성공 적용 후 capability fragment를 소비해 reload에서 공유창이 다시 열리지 않는다.

기존 editing/UI1440/1280/390/360, 실제 API sync/conflict/account deletion, privacy13시나리오/GPC/DNT, pricing390/1440/JS-OFF, service worker와 API/web build도 PASS. 전체 synthetic-schema `pg_dump`/`pg_restore` 리허설 PASS. disposable browser contexts, synthetic 작성자/workspace, restore sibling DB/dump, test PostgreSQL cluster와 모든 검증 서버를 정리했다.

근거: `/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-template-release-verify.log`, 같은 temp root의 `lcm-template-evidence/template-author-{1440,390,360}.png`, `template-reader-{1440,390,360}.png`. desktop/mobile 실제 화면을 직접 확인했다. 이전 실패 실행의 로그/스크린샷도 진단 근거로 남겼으며 성공 근거와 혼동하지 않는다.

`git diff --check` PASS, UI freeze worktree clean 확인. 이 담당은 전문 agent/독립 reviewer 호출 도구가 없어 직접 구현·검증했으며 **독립 리뷰는 메인이 별도 수행해야 한다**. 프로덕션 migration/배포, push/merge는 미실행. Owner 승인·독립 검토·운영 백업/rollout gate를 통과하기 전 공개 완료로 보고하지 않는다.
