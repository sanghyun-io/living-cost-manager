# LCM 990원 / 9,900원 결제 준비 — 2026-10-06

## 결정과 현재 완료 경계

- 고객 결과: 다음 결제 전에 구독 갱신을 판단하는 저가 대중형 서비스. 박리다매를 기준으로 **월 990원 / 연 9,900원**을 이번 준비 작업의 가격 기준으로 삼는다. 과거 월 2,900원 가설을 대체한다.
- 부가세 포함 **가정**이다. 판매 사업자의 과세 유형·상품 세무 처리는 미확인이다. 최종 판매 조건/계약 승인이나 실제 지불 의향 검증 완료를 뜻하지 않는다.
- 정확한 금액의 공유 catalog + 가이드/FAQ 가격안 안내를 구현했다. 현재 로컬 대시보드는 결제 없이 이용 가능. 유료 제공 범위는 미확정이며 기존 기능을 잠그지 않는다.
- 결제 SDK, 카드 입력, 주문/결제 endpoint, provider credential, webhook, 갱신 worker, 유료 entitlement, 신규 개인정보 저장, DB migration을 **추가하지 않았다**. 공개 mock 결제도 없다. `previewServicePrice`는 엄격한 plan ID만 받아 정수 KRW 총액을 반환하는 **미리보기**이며 주문/과금 승인이 아니다.
- 성공 지표: 코드상 990/9900/825/1980 정확성, guide/FAQ 일치, 결제 비활성의 명확한 표시. 지불 의향·실제 결제·반복 사용·매출/수익은 아직 미검증이다.
- 외부 계약/비용 확정 전에 provider-neutral preparation을 유지한다. LCM에 승인된 sandbox 상점/키 범위는 미확인. 다른 서비스 키를 찾거나 사용하지 않았다.

## 공식 근거와 provider 비교

아래 공식 페이지를 **2026-10-06 직접 조회**했다. 공개 표준 요금은 LCM 가맹점 견적이 아니다. 우대율·면제·LCM 승인 여부는 추정하지 않는다.

| 선택지 | 확인된 공식 근거 | LCM 판단 / 미확인 |
|---|---|---|
| Toss 직접, 국내 카드 | [요금표](https://www.tosspayments.com/about/fee): 일반 신용/체크카드 3.4%, 수수료 VAT 10% 별도. 표시 가입비 220,000원 최초 1회, 연관리비 110,000원 연 1회, 계약형태에 따라 상이. | 카드가 소액 결제에 적합. LCM 실제 카드/빌링 수수료, 가입·연관리비의 최종 세금 포함 견적, 면제·보증보험·정산 조건 미확인. |
| Toss 계좌이체 / 가상계좌 | 같은 요금표: 계좌이체 2.0%, 최저 건당 200원; 가상계좌 건당 400원, 수수료 VAT 별도. | 990원에서는 각각 최소 수수료 VAT 포함 약 220원 / 440원이라 우선 제외. 9,900원도 이체 198원은 200원 하한 적용. 자동계좌 빌링의 개별 계약 요율을 이 일반 표로 확정하지 않는다. |
| Toss 최소 금액 / 정기결제 | [카드 정책](https://docs.tosspayments.com/resources/glossary/card-payment): 카드 최소 100원. [V2 빌링](https://docs.tosspayments.com/guides/v2/billing): 카드·계좌 지원, 리스크 검토 및 추가 계약, 가맹점이 스케줄링. | 990/9900은 공개 카드 하한 이상. LCM 빌링 채널의 실제 하한·승인·카드별 제한은 계약 및 sandbox로 별도 확인. 정기결제 개통 완료 아님. |
| PortOne V2 + 별도 PG | [2026-07-31 게시 요금표](https://www.portone.io/pricing): 월 순거래액 5,000만원 미만 Free; 5천만~1억원 미만 월 100,000원, 1억~5억원 미만 300,000원, 5억원 이상 500,000원, VAT 별도. 취소/환불액을 제외한 월 순거래액 기준. | **PortOne 플랫폼 무료는 PG 수수료 무료가 아니다.** PG별 요율/하한/빌링 특약 미확인. 월 거래액 문턱을 넘는 비용은 별도 승인 필요. |
| PortOne 신규 계약/프로모션 | [필수 구축요건](https://help.portone.io/content/requirements): 상품·정확한 금액·환불·약관/개인정보·판매자 정보 및 결제 모듈 심사. [추천패키지](https://help.portone.io/content/content200013), 페이지 날짜 2025-05-01: 가입비·연회비 면제 안내. | LCM 적용/유효기간/PG 조합은 **미확인**. 면제를 예산에 확정 반영하지 않는다. [바로오픈](https://help.portone.io/content/open-immediately)은 정기결제 미지원, 빌링 특약/심사 필요. 여기의 카드 3.2%를 LCM 정기결제 요율로 사용하지 않는다. |

**기술 우선 후보: PortOne V2 + 심사된 국내 카드 PG.** 이유는 Harudo의 `backend/package.json`에 `@portone/server-sdk ^0.19.0`가 있고 `docs/portone-readiness-guide.md`에 V2 정기결제/서명 webhook 준비 사례가 있기 때문이다. 이는 연동 지식 재사용 가능성이지 LCM의 계약/키/승인/수수료를 입증하지 않는다. 기존 Harudo 문서도 상점별 승인 경계를 별도로 둔다. 해당 서비스의 가맹점 계정·채널·빌링키·고객 데이터는 재사용하지 않는다. Toss 직접은 PortOne 비용/조건이 불리하면 비교할 대안이다. 최종 PG 선택은 LCM 서면 조건 이후이며 지금 SDK 의존성을 넣지 않는다.

## 가격과 단위경제 계산

- 월간 12회: **11,880원**. 연간 1회: **9,900원**. 차이 **1,980원**, 정확히 `1/6` (= 약 **16.7%**), 20%가 아니다.
- 연간 월환산 **825원**은 비교값. 결제 총액은 항상 **9,900원**, 월별 825원 청구가 아니다.
- 카드 일반 3.4% + 수수료 VAT 10%를 **비교 가정**으로 적용한 산술 (원 미만은 설명용이며 실제 PG 절사/반올림은 계약 확인):

| 고객 결제 총액 | PG 기본 수수료 | 수수료 VAT | 수수료 현금 유출 합계 | PG 공제 후 현금 |
|---:|---:|---:|---:|---:|
| 월 990원 | 33.660원 | 3.366원 | 37.026원 | 952.974원 |
| 연 9,900원 | 336.600원 | 33.660원 | 370.260원 | 9,529.740원 |
| 월 990원 ×12 | 403.920원 | 40.392원 | 444.312원 | 11,435.688원 |

연간은 고객이 덜 지불하므로 사업자의 순유입도 월간 12회보다 작다. 동일 비례 수수료라면 거래 횟수 감소 자체가 수수료율 이득은 아니다. 재시도/문의/이탈 및 계약상 건당 비용은 미검증이다.

일반 과세·고객가격 VAT 포함 10%라는 **가정**이면 990원은 공급가 900원/매출 VAT 90원, 9,900원은 9,000원/900원이다. 수수료 VAT 공제 가능 가정에서는 공급가에서 PG 기본 수수료를 뺀 866.340원 / 8,663.400원; 공제 불가 가정에서는 862.974원 / 8,629.740원. **세무 확정/이익이 아니다.** 고정 PG비, 플랫폼/서버/스토리지/트래픽, 고객지원, 환불/실패, 회계·세금·운영 비용을 아직 차감하지 않았다. 손익분기 고객 수는 이 비용과 LCM 실견적 없이는 확정하지 않는다. 연간 선납도 현금 수취와 수익 인식/환불 부채를 구분해야 한다.

## 결제·이용 상태 계약 — 내부 초안, 비활성

현재 구현 상태는 오직 `planned`, checkout OFF다. 아래는 provider 구현 전에 Owner/법률 검토로 확정할 **초안**이며 코드상 갱신/해지/환불 결정을 실행하지 않는다.

| 상태/전이 초안 | 필요한 서버 근거 | 금지 / 보류 |
|---|---|---|
| planned → pending | 승인된 LCM 상품/상점, 로그인 소유자, 서버 주문·가격 catalog version, 최종 약관/가격/정기결제 동의 | 미리보기·로컬 저장·클라이언트 success만으로 주문/권한 생성 금지 |
| pending → active | 서버가 PG 조회로 상점/테스트 여부/결제ID/주문/통화/금액/paid 검증, DB transaction에서 결제ID 유일성 및 기간 생성 | 중복 webhook/완료 요청으로 기간 중복 연장 금지; 서명만으로 paid 확정 금지 |
| active → cancellation_requested → end_of_term | 소유자 확인, 서버가 미래 예약/갱신 중지 확인 | 기간 말까지 접근 유지하는 안은 **초안**. 해지와 환불은 구분; 법적 청약철회 권리 등을 이 초안으로 제한하지 않음 |
| active → renewal_pending → active / payment_failed | 최신 동의 범위와 취소/만료 상태를 잠금 후 확인; 주문/기간 단위 idempotency | 실패 재시도 횟수·grace 기간·회수 시각 미확정. 취소 후 자동 재청구 금지 |
| active → expired | 검증한 paid-through 경계 | 자동 fallback 유료 접근/로컬 unlock 금지. 기존 무료 데이터의 열람·내보내기 손실 방지 |
| refund_requested → manual_review → refunded / reviewed | Owner/필요 법률 판단, PG 환불 결과 조회/대사, 승인한 권한 조정 정책 | 환불 공식·무조건 N일·수수료 고객 전가·환불 불가 약속을 생성하지 않음 |

이용 기간은 서버의 명시적 timezone/달력 기준 및 `[start, end)`로 정해야 한다. 월간을 30일, 연간을 365일로 고정하지 않는다. 1/31 → 2월 말 → 3/31 고정 anchor, 윤년 2/29 → 다음 해 2/28, 월/연 변경·중도 변경·환불 기간을 승인 후 테스트해야 한다. 현재 tracked expense 일정 로직을 과금 정책으로 자동 전용하지 않는다.

## 개통 체크리스트와 실제 다음 게이트

| 게이트 | 현재 | 완료 근거 / 승인 경계 |
|---|---|---|
| 판매 상품·유료 범위·최종 VAT 가격 | 준비 기준만 있음 | 990/9900 유지 또는 변경 결정, 기존 무료 고객 영향, 사업자 과세 유형 세무 확인 |
| LCM 판매자 및 정산 주체 | 미확인 | Owner가 사업자/대표/주소/응대 연락처/신고 적용/정산계좌를 확인. Harudo 공개 사업자 정보를 자동 복제하지 않음 |
| 이용약관·개인정보·정기결제 동의·해지/환불 | 내부 상태 초안만 있음 | 실제 상품에 맞는 고지/동의 철회/보존·삭제/분쟁처리. 필요한 법률 검토; 법정 준수 단정 금지 |
| PG 선정/서면 견적·LCM URL/업종 심사 | 미확인 | 990원 카드/빌링 하한, VAT/우대율/건당 하한, 가입/연회비/보증보험/정산 한도/빌링 승인. 연락·신청·유료 계약은 Owner 승인 후 |
| LCM-scoped sandbox | 미확인 | 승인한 비운영 상점/채널/credential scope와 공식 SDK 문서 확인. 비밀은 private store 참조만, 로그/클라이언트/Git 노출 금지 |
| 구현·보안 | preview만 완료 | hosted provider UI만 사용, 카드 직접 수집 금지; auth/소유자/서버 quote/동의, signed webhook 검증/재조회/재생·중복 방지, 금액/환경/상점 검증, secret 접근·대사 설계 |
| 결제 저장/권한/worker | 구현 안 함 | 프로덕션 DB 변경 필요시 LCM 승인 범위 + 백업/복원 리허설 + 호환성/잠금·중단/단계 rollout/rollback 먼저 확인; production 쓰기 없는 sandbox 테스트 |
| 최소 테스트 | 가격 preview 테스트 있음 | sandbox 승인/실패/취소/해지/환불·중복/순서역전/금액변조/서명불일치/타계정·상점/동의누락/달력기간/worker 중복 및 취소 경합 검증, 독립 reviewer/security 검토 |
| 운영 개통 | OFF 유지 | 명시적 과금 개시 승인, 실제 계약·법률/세무 조건, 대사/모니터링/지원/rollback 준비. 유료 리소스·권한 확대 승인 없이 실행 금지 |

추가 PII beta 대기명단은 만들지 않는다. 가이드의 기존 자발적 문의 링크만 제공하며 문의가 결제 신청/마케팅 동의가 아님을 명시한다. unsolicited 연락/메일, 고객 결제, 가입/계약 신청은 수행하지 않았다.

## 검증/배포 기록

작업트리: approved temp root `lcm-pricing`, branch `feat/pricing-readiness-20261006`, 기준 source `97520946452e28ba96d2c85ae4c9865cc05e5f65`. 기존 원본 dirty checkout 및 마케팅 작업트리는 변경하지 않는다.

- `pnpm verify:usability`: **463 application tests** (shared 109 / web 209 / API 145), operator 17 / ownership 2 / service worker 3, API/web production build, 1440/390 usability·로컬 실제 API 동기화·계정삭제 및 13 marketing privacy 시나리오 통과. 최종 재실행에는 가격 전용 브라우저 검증도 통합되어 모두 통과했다. purpose-created local PostgreSQL만 사용했으며 임시 DB/서버 종료·삭제 완료. 최종 로그: approved temp root `lcm-pricing-fullverify-final.log` (초기 실행 `lcm-pricing-fullverify.log`도 보존).
- 최초 가격 전용 테스트 17개: 정수 KRW 990/9900, 825원 비교값, 1,980원/정확한 1/6 할인, unknown plan·클라이언트 amount/currency/discount/consent 변조 거절, 불변 planned/OFF preview. 독립 리뷰 권고 후 primitive/array 및 own `__proto__`/unknown key/inherited plan/symbol 필드 검증을 추가해 23개로 확장했다. own `__proto__`를 Zod가 무시하는 회귀 실패를 발견하여 원본 own-key 검사로 보강했다. 주문·동의·권한을 반환하지 않음. 서버 checkout·webhook이 없으므로 결제 중복 통보/서명/달력 과금 테스트가 완료됐다고 주장하지 않는다.
- `pnpm verify:pricing`: 390/1440에서 guide/FAQ/FAQ JSON-LD 카피 일치, 정확한 금액과 구매 불가 안내, 카드 입력/가짜 checkout/provider script 없음, mutation·외부 요청 없음, runtime error/overflow 없음. 정적 HTML에서도 JS 없이 가격/준비 상태 표시 확인.
- 독립 리뷰 권고 반영 후 최종 `pnpm verify:usability` 재실행: **469 application tests** (shared 115 / web 209 / API 145), 위 operator/ownership/SW·production builds·모바일/데스크톱·실제 로컬 API sync·13 privacy·가격 browser 검증 모두 통과. 로그 `lcm-pricing-reviewed-fullverify-final.log`; 첫 own-key 회귀 실패 로그 `lcm-pricing-reviewed-fullverify.log`도 보존한다. 생성한 임시 cluster와 테스트 서버 정리 완료.
- 공식 요금 산술은 별도 Node 계산으로 재확인했다. JS 원 미만 부동소수 결과는 문서에서 3자리로 표시했으며 PG 실제 정산 반올림과 다를 수 있다.
- 메인 조정자가 독립 reviewer `ses_ef0fa6d42ffedG651tpdYhg3pZ` 및 security `ses_ef0f4cc48ffeXpLO6qZHNRcySg`의 **PASS / no blocker**를 전달했다. reviewer는 shared 109와 가격 browser 검증을 부분 재현했고 전체 463은 이 실행자의 로그 근거다. 권고 후 위 own-key 검사, 역사적 2,900원 명시, 공유 package prebuild/브라우저 assertion 보강을 수행했다. security의 경계대로 `checkoutEnabled=false`를 가맹점/법률/세무/보안 조건 및 카피 검토 없이 켜지 않는다. 자체 재검증을 독립 재리뷰로 부풀리지 않는다.

배포 전 운영 baseline은 기존 [마케팅 배포 기록](marketing-release-20261005.md)의 `b5bdb0bcf4c032b43cf1a33efdae1b0abc8709f5`였고, 원격 main은 준비 기준 `9752094…`였다. 독립 리뷰 권고 반영 후 **`c77079d622e23e2f763411f95e7dc6b2f7a92ab0`의 OCI/Pages paired 배포를 완료**했다. 현재 공개 API header/body 및 두 FE release metadata가 동일 SHA이며, 공개 guide/FAQ/JSON-LD에 월990/연9900 **준비 중·구매 불가** 안내를 직접 확인했다. 운영/모바일·데스크톱/개인정보 검증, 실제 image digest/Pages ID 및 롤백 근거는 [가격 배포 기록](pricing-release-20261006.md)을 따른다. 실제 과금은 계속 OFF이며 준비가 billing 구현/가맹점 승인/매출 검증을 뜻하지 않는다. 신규 provider/환경변수/route/DB/worker 설정이 없어 현 단계 gamja-ops asset 변경은 없다. 실제 결제 연동시 callback·secret 참조·worker/DB 소유권을 authoritative gamja-ops에도 등록해야 한다.
