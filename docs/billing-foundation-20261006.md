# LCM 결제 기반 구현 인계 — 2026-10-06

이 문서는 준비 구현과 단계별 검증 기록이다. 후속 독립 검토·runtime guard 보강·비과금 배포의 실제 source/운영 근거는 [billing/UX release](billing-ux-release-20261006.md)를 따른다. 아래 초기 단계의 '배포 없음'은 해당 단계 당시 기록이며 실제 결제 OFF 경계는 배포 후에도 동일하다.

## 목표와 완료 경계

고객이 결제 전 총액·기간·갱신·해지/환불의 차이를 이해하게 하고, 서버에서 가격/기간/결제 상태를 일관되게 판단할 최소 기반을 마련한다. **실제 결제 OFF**. 기존 무료 기능은 제한하지 않는다. 매출·지불 의향·실사용 가치 검증은 미완료다.

- 기준 `origin/main` = `fe0c568`; 별도 `feat/billing-foundation-20261006` / approved temporary root `lcm-billing`. 원본 dirty checkout 보존.
- 구현: `apps/api/src/services/service-subscription.ts`와 도메인 테스트, 공개 guide의 준비 안내, 가격 browser assertion 추가.
- 서버 도메인은 앱 route에 연결하지 않았다. sandbox는 **실제 PG sandbox가 아니라 순수 테스트 모델**이다. 카드 등록/빌링키/SDK/webhook/주문 endpoint/갱신 worker/secret/env/새 operator endpoint 없음. 기존 Harudo 키나 환경은 조회·복사하지 않았다.
- PortOne V2 + KCP를 선택한 맥락을 전제로 한다. LCM 가맹점/빌링 승인·sandbox 권한은 미확인이다. KCP 990원 하향 연락·응답·추가 문의는 **사용자 담당 / 이번 작업 범위 밖**이며 로컬 도메인 검증의 장애물이 아니다.
- 프로덕션 접근·스키마 변경·배포 없음. 독립 리뷰는 메인 세션에서 요청해야 한다. 테스트 통과는 독립 리뷰/법률 검토/배포가 아니다.

## 실행 가능한 도메인 계약

1. 서버는 `previewServicePrice`의 immutable catalog만 사용한다. 엄격한 plan ID 요청에 amount/currency/discount를 섞으면 거절한다. 월 990 / 연 9,900 KRW 정수. 825는 월환산 비교값이며 결제 총액 아님. VAT 포함은 여전히 미확인 가정이다.
2. 기간은 `Asia/Seoul` **자정** anchor와 `[start,end)`이다. 신청일 기준 일할·즉시 개시 정책은 미정이며 이 모델로 자동 확정하지 않는다. 원래 anchor 일자를 고정해 짧은 달만 clamp한다. 1/31 → 2월 말 → 3/31, 윤년 2/29 연간 → 다음해 2/28 → 다음 윤년 2/29. 4/30은 다음달 5/30이며 모든 말일을 '항상 말일'로 간주하지 않는다. 시각 보존/말일 옵션이 필요하면 별도 승인·테스트한다.
3. `createSandboxAttempt`는 로그인 소유자를 서버가 제공한다는 전제의 준비 record다. 요청 body로 record 전체를 받으면 안 된다. 실제 주문 생성/승인이 아니다.
4. `reconcileAttempt`는 **서버 provider 조회 결과**와 저장된 시도를 대조한다. 상점/환경/payment ID/통화/정수 총액 불일치는 실패한다. 서명 webhook body 또는 client success만으로 호출하면 안 된다. 조회 시각은 신뢰된 서버 clock이다. 같은 attempt의 재조회는 직렬화해야 한다.
5. paid 최초 전이만 기간 후보를 반환한다. 중복 성공은 연장하지 않고, 이전 조회/동일 조회 시각은 무시하며, paid 이후 늦은 failure는 되돌리지 않는다. 조회 실패는 state를 변경하지 않고 같은 payment ID로 다시 **조회**한다. 새 charge를 재시도하는 구현이 아니다.
6. refunded는 `refund_review`로 분리한다. paid callback이 늦게 와도 자동 기간 발급/환불 되돌림을 하지 않는다. 환불 amount/부분환불/기간 권한 조정은 별도 ledger 및 승인 정책 필요.
7. 취소 intent는 결제 시도와 별개다. 준비 lifecycle은 pending/scheduled/paid_period/ending/expired/payment_failed/refund_review를 구분하지만 실제 계정의 구독 라벨이 아니다. provider 예약 취소를 실행했다는 반환값도 만들지 않는다. 어떤 상태에도 `nextChargeAllowed=false`다.
   시작일 전에는 취소 intent가 있어도 state는 `scheduled`이고 별도 `cancelFutureCharges=true`를 보존한다. `ending`은 후보 기간 안에서만의 설명이다. 이는 실제 취소/환불 정책 확정이나 예약 취소 완료가 아니다.
8. `resolveServiceEntitlement`는 account 소유 기간을 서버에서 확인하되 항상 **free / paidAccess=false**다. sandbox 기간 후보나 로컬 저장 flag로 paid가 되지 않는다. 기능 개통은 catalog flag 한 줄 변경으로 완료되지 않으며 승인된 live period 전용 entitlement 구현/독립 보안 리뷰가 필요하다.

## 저장 구조 결정 — 필요한 장기 구조, 아직 적용하지 않음

유료 개인 계정에 **account당 하나의 subscription contract**를 둔다. 현재 User가 auth/계정 삭제의 주체이고 workspace는 공유 편집/가계부 데이터 범위다. 팀 구독이나 workspace owner 권한으로 결제를 대리하지 않는다. 결제 금액을 FixedCost/PaymentCard에 넣지 않는다(둘은 사용자가 기록하는 지출/카드 별칭이다).

실제 sandbox 연동 전에 Prisma additive schema + migration + 격리 DB transaction 테스트를 작성해야 한다. 현재 비활성 모델을 위해 운영에 빈 table을 먼저 만드는 효익이 없어 이번에는 migration도 생성하지 않았다. **durable persistence 구현 완료가 아니다.** 필요한 구조:

| Record | 최소 불변/경합 계약 |
|---|---|
| SubscriptionContract | unique User/account, catalog version, plan, original date anchor/timezone, consent version/time, cancel intent, optimistic version. 삭제 cascade/보존은 법률 판단 후 결정 |
| PaymentAttempt | unique provider+merchant+environment+payment ID; contract+cycle당 하나의 청구 의도. immutable quote snapshot, 금액 KRW Int, 조회 상태/시각. 계약/주문ID를 서버에서 생성 |
| PaidPeriod | unique attempt; `[start,end)`, account/contract 참조, 동일 cycle 이중 지급 금지. sandbox와 live 분리 |
| BillingEventReceipt | unique provider+merchant+environment+event ID; processing/applied/retry_required, lease expiry/attempt count. 원문 body·카드·PII는 기본 저장하지 않음. 내용 충돌/잘못된 서명은 격리 |
| RefundRecord | 별도 unique refund ID, verified amount/status, 원결제 참조, 수동 승인 audit. 부분환불과 자동권한조정은 별도 정책 |

### Webhook/worker transaction 순서

- 허용한 LCM 상점/환경 및 공식 서명/시간 검증 → 이벤트 receipt unique insert/claim. webhook 수신은 결제 승인 증거가 아니다.
- 서버 lookup 실패: receipt retry_required, bounded backoff/alert. ACK 정책은 provider 문서에 맞춰 결정. raw event를 덤프하지 않는다.
- account contract + payment attempt row lock 아래 authoritative lookup/reconciliation을 직렬화한다. provider call이 긴 경우 lease/fencing token을 사용하고 lock holding 시간 검증 필요.
- reconciliation + unique paid period + receipt applied를 **단일 transaction**으로 commit. commit 전에 죽으면 전체 rollback하고 재조회. commit 후 ACK 유실은 duplicate receipt가 처리해 기간을 다시 지급하지 않는다.
- older event는 현재 provider 상태를 재조회한다. 현재 테스트는 순수 상태 전이/단일 attempt 중복·역순·failure retry를 검증할 뿐, DB rollback/동시 event unique/서명/retry queue 테스트를 대신하지 않는다.
- 청구 직전 같은 contract lock에서 cancel intent/새 동의 범위/예정 cycle를 확인한다. 취소 수락은 미래 예약 중지까지 확인한 뒤에만 '완료' 표시. 이미 in-flight인 결제는 별도 대사/고객지원. 결제 요청 timeout에 새 payment ID로 재청구 금지: 동일 ID 조회 후 PG idempotency 계약을 따른다.
- ordinary JWT만으로 operator endpoint 열지 않는다. 새로운 operator API는 이번에 없다. 유료 접근 결정은 서버로만 수행한다. 고정비/이메일/금액/결제ID를 기존 analytics에 전송하지 않는다. default-off / GPC / DNT 유지.

### DB rollout gate

실제 사용 근거와 승인된 LCM sandbox가 생긴 뒤 draft migration을 격리 DB에서 검증한다. 운영 적용 전 별도 명시 승인 범위, backup/복원 리허설, 구버전 auth/account deletion 호환, 잠금/대용량 영향, additive rollout/rollback, 독립 reviewer/security를 확인한다. 기존 조건부 DB 승인을 blanket approval로 해석하지 않는다. 운영 DSN/고객 결제 데이터는 이번 작업에서 읽지 않았다.

## 비구속 법률/상품 검토 작업지 — 전문가/Owner 확정 필요

아래는 약관이 아니라 **검토 항목과 고지 위치의 초안**이다. 법정 N일, 환불 불가, 임의 수수료 공제, 90일 보존, 동의 하나로 자동결제+마케팅을 묶는 문구를 만들지 않는다.

| 위치 | 출시 전에 확정할 내용 |
|---|---|
| 상품/판매자 화면 | 실제 유료 제공 범위와 기존 무료 범위, 결제 총액/VAT, 연간 선납 9,900원과 825원 비교 구분, 판매자/주소/문의/신고 적용 정보(미확인 정보 복사 금지) |
| 신청 직전 | 시작/종료/갱신일·다음 총액·변경 고지, 자동갱신 동의 별도 미선택 checkbox 및 버전 증거. 약관/개인정보 안내와 마케팅 선택동의 구분. provider hosted billing-key 등록과 실제 charge 구분 |
| 구독 관리 | 미래 자동청구 중지 경로, 수락/처리/완료 상태, 이미 낸 기간의 처리, 별도 청약철회/환불 문의 경로·처리 기간·분쟁 해결. 계약 취소와 법정 권리를 내부 정책으로 혼동/제한하지 않음 |
| 실패/환불 | 자동재시도 횟수와 시점, 고객 사전 안내, grace/access 정책은 **제안 미확정**. 부분/전액/연간 선납 환불 계산·법정 권리·사용 개시의 영향은 전문가가 실제 상품에 맞춰 판단 |
| 개인정보/계정 삭제 | provider와 역할/위탁·전송 범위, 최소 token reference만 서버 저장(카드 번호/CVC 직접 저장 없음), 동의 철회, 결제 기록의 법정 보존/접근 제한·삭제 시점과 계정 삭제 충돌 검토. 임의 보존기간 확정 금지 |

공식 확인 출발점: [국가법령정보센터](https://www.law.go.kr/), [공정거래위원회](https://www.ftc.go.kr/), [개인정보보호위원회](https://www.pipc.go.kr/). 이번 변경은 해당 법령의 최신 조항·상품 적용 검토를 완료한 것이 아니며 법적 준수를 보증하지 않는다. 외부 공개 법률 문서/구속 계약 문안은 전문가 검토와 Owner 승인 후 별도 작성한다.

## 고객 가치: 기존 reminder targeted audit

소스 `apps/api/src/jobs/send-due-reminders.ts` 및 기존 격리 DB `send-due-reminders.test.ts`를 검토했다. D-1 묶음, 기준일 없는 비월간 항목 제외, unique(userId,dedupeKey), 일반 발송 실패/0건 성공 시 receipt 삭제로 재실행 가능하다. 운영 worker 활성/실제 수신/재방문 성과는 이번에 확인하지 않았다.

**남은 신뢰성 위험:** receipt 선점 후 send 전에 process가 죽으면 기록만 남아 다음 실행이 건너뛸 수 있다. `services/push.ts`는 device별 일시적 오류를 무시하므로 일부 성공이면 job receipt가 남아 실패 device가 같은 날 재시도되지 않는다. 일부 device 성공 뒤 후속 DB 정리 등이 throw하면 receipt 삭제 후 재실행 시 성공 device에 중복 발송할 수 있다. PushDelivery는 sentAt만 있어 pending/sent/lease recovery 구분이 없다. 기존 테스트는 crash recovery나 exactly-once 전달을 입증하지 않는다. 임의 worker/DB 변경은 하지 않았다. 다음 실제 고객가치 작업 후보는 claim lease + per-endpoint delivery/outbox를 격리 DB로 테스트하고 운영 상태를 별도 승인 범위에서 확인하는 것이다. paid 기능으로 포장하지 않는다.

## 메인 조정자에게 인계할 검증/다음 행동

- 전체 `verify:usability` 결과는 아래 실행 기록에 추가한다. purpose-created local PostgreSQL과 별도 headless Chromium을 사용하며 main의 browser extension/KCP 탭을 조작하지 않는다.
- 독립 읽기 전용 reviewer/security에게 도메인 검증 경계, irreversible status, 날짜 정책, public 안내의 오해 가능성, analytics/무료 기능 무변경을 확인 요청. 리뷰 전 배포하지 않는다.
- 리뷰 통과 후 원한다면 runbook에 따라 noncharging FE/BE paired same SHA 배포만 별도 수행. 현재 source는 아직 운영에 없다.
- 사용자 결정이 필요한 것은 최종 상품/법률·세무/판매자 조건과 LCM-scoped sandbox/개통 승인이다. KCP 문의 작업은 사용자 담당. 사소한 UI 선택을 추가 승인 요청으로 만들지 않는다.

### 이번 실행 결과

`LCM_TEST_TEMP_ROOT=<approved temp root> PG_BIN=/opt/homebrew/opt/postgresql@16/bin pnpm verify:usability` 통과. 로그 `<approved temp root>/lcm-billing-verify.log`.

- Application **506** (shared 115 / web 209 / API 182; 기존 469 + 새 서버 도메인 37). operator 17 / ownership 2 / service worker 3는 별도 집계.
- API/web production builds; 1440/390 usability; 실제 로컬 API sync/conflict/relogin/account 삭제; 13 marketing privacy 시나리오; 가격/준비 안내 browser+JS 없는 HTML 검증 통과.
- 테스트용 PostgreSQL cluster 삭제 및 모든 검증 서버 종료 로그 확인. 운영 DB 미사용. browser는 별도 headless 프로세스로 사용자 탭 미조작.
- `git diff --check` 통과. **독립 리뷰/배포 미실행**.

### 독립 검토와 추가 hardening

메인 조정자가 reviewer `ses_eefd9dd79ffeLw34Q6M2nEnSUG`, security `ses_eefd9b2dcffeX5WuQ3aY3yyVH3`의 **PASS / blockers 0**를 전달했다. 검토자가 직접 재현한 shared115 / billing37 / consent6 / API TypeScript build는 구현자의 전체 회귀 로그와 별도 근거다.

이후 권고에 따라 account/payment/merchant reference에 runtime `typeof string`, 빈 문자열/공백-only/200자 상한 검사를 추가하고 각 필드의 number/object/array/boolean/null/undefined 및 경계값을 테스트했다. 취소 intent도 runtime boolean만 허용한다. 이 후속 작은 guard 수정의 독립 재리뷰 완료를 주장하지 않으며, 메인 조정자의 해당 수정·회귀검증을 조건으로 한 비과금 배포 승인에 따른다. Durable unique/lock/fence/atomic ledger와 실제 billing routes는 여전히 미구현·비활성이다.

Hardening 후 `verify:usability` 전체 재실행 **557 application tests** 통과(shared115/web210/API232; billing domain87). operator17/ownership2/SW3는 별도다. Production builds, 실제 격리 API sync/삭제, 1440/390 layout/keyboard/focus, 기존13 privacy와 pricing/static HTML 모두 통과. 로그 `<approved temp root>/lcm-billing-hardened-verify.log`; 모든 임시 DB/서버 정리 확인. 실제 과금 OFF.
