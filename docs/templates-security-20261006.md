# 고정비 설계도 보안 리뷰 대응 — 2026-10-06

`feat/templates-20261006`(베이스 `81bc64a`)에 대한 독립 보안 리뷰(B1/N1/N2)와 후속 리뷰
(B4/B5/C10)를 백엔드에서 해결한 내용과, **배포 전 운영이 read-only로 직접 확인해야 할
gate**를 구분해 기록한다. 프로덕션 DB migration·배포는 여전히 미승인/미실행이며, 이
문서는 어떤 프로덕션 상태도 완료로 주장하지 않는다.

## 1. B1 — 레이트리밋 키가 리버스 프록시 socket 하나로 합쳐지던 문제

### Before → After

| 경로 | Before (리뷰 지적) | After |
| --- | --- | --- |
| `/templates*` 인증 6종 | 기본 `onRequest` 훅 + `req.ip` 키 → nginx 뒤에서 **전 고객 공유 60/분** | 라우트별 `hook: "preHandler"` + 검증된 JWT `sub` 키 → 사용자별 60/분. 인증 실패(401/403)는 limiter 도달 전에 즉시 종료 → 잘못된/만료 토큰이 정상 사용자 버킷을 소진할 수 없음 |
| `/template-shares/:token` | `req.ip` 키 → **전 익명 고객 공유 30/분**, 한 명 버스트가 전체 공개 열람 차단 | (client, token) 단위 30/분 + 스윕 계층. malformed probe token은 DB에 닿지 않는 단일 저가 공용 버킷으로 수집해 키 폭증 방지 |
| 프록시 trust | `trustProxy` 미설정 + XFF 무검증 | `TRUST_PROXY` env gate(기본 `off`). `loopback`은 아래 검증 완료 후 인스턴스 단위 승인 시에만 |

- keyGenerator는 JWT를 자체 디코딩하지 않는다. `verifiedUserKey`는
  `app.authenticate`(서명 + iss/aud + tokenVersion DB 검증)가 채운
  `request.user.sub`만 읽고, 없으면 401로 fail-closed 한다.
  `@fastify/rate-limit` v10.3.0의 onRoute 처리가 routeOptions.preHandler에
  자체 핸들러를 **후추가**하므로(limit-before-handler 없음, authenticate-after-limiter 없음)
  순서가 보장된다 — 경쟁 테스트가 아닌 설치본 소스 확인 + 동작 테스트로 검증.
- 버킷 키에 raw IP·capability token을 넣지 않는다: 익명 키는 프로세스 수명 salt로
  소금 친 SHA-256 앞 22자(base64url), 인증 키는 `sub`(로그·DB·응답 미노출).
  salt는 재시작·인스턴스 간 재현 불능이고 어디에도 저장되지 않는다.
- 메모리 bound: LocalStore는 toad-cache LRU로 키 수 상한(기본 라우트당 5000,
  인증 라우트는 `cache: 5000` 명시). 동적 키로 힙이 무한 성장하지 않는다. 카운터는
  프로세스 메모리 전용이며 영속화·redis 없음.

### 익명 스윕 계층의 정직한 두 단계

- `TRUST_PROXY=off`(기본, 검증 전): `request.ip`는 nginx socket 하나라 고객 구분
  능력이 **없다**. token 단위 (client, token) 30/분 + instance 공용 스윕 120/분만
  동작한다. 이 상태의 익명 분리는 **share-token 단위까지**이며 per-client를
  주장하지 않는다. instance 스윕은 rotating-token flood가 DB lookup을 무한 생성하는
  것을 막는 상한이다.
- `TRUST_PROXY=loopback`(검증·승인 후): 즉시 hop이 loopback(같은 호스트
  nginx/cloudflared)일 때만 XFF를 신뢰 → 클라이언트별 90/분 + (client, token)
  30/분. loopback이 아닌 socket이 보낸 XFF는 무시된다(테스트: 비신뢰 socket의
  스푸핑 XFF 교체는 새 버킷을 만들지 못하고, 신뢰 사슬 내 서로 다른 XFF는 분리된다).
- 어떤 모드에서도 blanket `trustProxy: true`는 코드에 존재하지 않는다(enum
  `off|loopback`). `CF-Connecting-IP`는 키 계산에 사용하지 않는다(직접 스푸핑 가능).

### 배포 전 read-only 검증 gate (본 브랜치에서 실행하지 않음 — 운영 절차)

인프라 변경은 `.ai/gamja-ops-policy.md`상 gamja-ops 동기화 + 별도 승인 대상이고,
SSH는 read-only 확인에만 사용한다.

1. `sudo nginx -T`에서 `living-cost-manager` 라우트의
   `proxy_set_header X-Forwarded-For`가 **overwrite(`$remote_addr`)**인지
   **append(`$proxy_add_x_forwarded_for`)**인지 미설정인지 확인. repo 어디에도 현재
   lcm 라우트의 XFF 동작은 기록돼 있지 않다(`docs/marketing-release-20261005.md`는
   "기타 라우팅·proxy headers 불변"만 기록 — 그 "불변"의 내용이 무엇인지 본 브랜치
   검증 범위가 아니다).
2. API 포트 4000에 연결할 수 있는 프로세스가 nginx(·cloudflared)뿐인지 확인
   (OCI security list/iptables/docker compose 바인딩 — repo의
   `docker-compose.prod.yml`은 `4000:4000`이라 호스트 노출 가능성이 있다; 실제
   운영 compose는 `/opt/livingcost/docker-compose.yml`). 노출이 있으면 external
   socket은 어차피 XFF를 무시하지만 instance 스윕 계산과 우회 경로가 달라진다.
3. 확인 결과대로면 compose env에 `TRUST_PROXY=loopback` 추가(gamja-ops
   `assets/services.yaml` env 재동기화, Owner 승인)하고, 서로 다른 실 IP 두
   클라이언트로 공개 조회 분리를 재현 확인.
4. 1~3이 불확실하면 `off` 유지 채로 배포하는 것이 안전측 기본이다(스푸핑으로
   버킷를 늘릴 수 없음 + token 단위 폭주 분리만 보장).

테스트 근거(`apps/api/tests/templates-security.test.ts`, 로컬 격리 PG): 서로 다른
인증 사용자 교차 비차단, 잘못된/폐기 토큰의 정상 버킷 무소진, burst의 token 간
격리, trust-off에서 스푸핑 XFF 파티션 무효, loopback trust에서 동일 토큰 다른
클라이언트 분리·비신뢰 socket 스푸핑 무효, 429 본문에 sub/token/IP 미노출.

## 2. N1 — 철회·만료 공개본의 프라이버시 기본값 (구현 완료)

- **명시적 철회**(`DELETE /templates/:id/share`)는 owner transaction 안에서 share
  행(token + pinned blueprint 텍스트)을 **물리 DELETE**한다. 대문 자취(revokedAt
  행) 유지가 사라져 철회 직후 불필요한 공개 텍스트가 계정에 남지 않는다. 재전송은
  deleteMany no-op이라 204 idempotent, 이후 공개 GET은 404.
- **private draft(BudgetTemplate)는 어떤 revoke/purge에도 포함되지 않는다** —
  공개 취소는 개인 데이터 삭제가 아니다. 초안은 소유자 삭제 또는 계정 삭제
  (User→BudgetTemplate→BudgetTemplateShare `onDelete: Cascade`, 스키마·테스트 확인)로만 사라진다.
- **만료 90일**: 조회 거부는 expiresAt 시점부터 보장된다. 물리 삭제는 cron 없이
  기회 소각 — owner 목록 GET과 owner publish에서 자기 계정의 stale share
  (만료 또는 legacy revokedAt 행), 공개 조회에서 **조회된 그 토큰**만
  (`token + revokedAt null + expiresAt<=now` 조건부 delete). 동시 republish는
  토큰을 rotate시키므로 조건부 delete가 새 게시본을 지울 수 없다(경쟁 시나리오
  테스트로 확인).
- **문구 상한**: 사용자 고지·UI에는 "90일 후 조회 종료, 내용 삭제는 이후 활동
  시점(정확한 날짜 보장 아님)"으로 쓰고 "90일에 완전 삭제"를 주장하지 않는다.
  정한 물리 삭제가 필요하면 Owner 결정으로 주기 정리 작업 추가(미구현).
- 프로덕션 테이블은 아직 미적용(데이터 0)이므로 legacy revoked 행은 실재하지
  않으며, 위 legacy 조건은 테스트 DB·향후 롤백 잔존분을 위한 것이다.
- 백업(OCI pg dump/회전)에는 물리 소각 시점까지 잔존할 수 있다 — 보존 정책
  최종 판단은 Owner(retentionaddon: 백업 회전 포함).

## 3. B4 — 계정 소멸과 동시 요청의 FK 500 제거

보호 5개 write 라우트(create/update/publish/revoke/delete)의 `FOR UPDATE`가 0행을
반환하면(authenticate 이후 계정 삭제 경쟁) 이후 write로 진행하지 않고 401
"Invalid token"(기존 auth와 동일 semantic)로 끝낸다. P2003 500·고아 row 경로가
없다. User 행을 확인하지 않고 write하는 guard는 없다. 테스트: 삭제 계정 + 유효
JWT → 401·생성 0; row lock을 실제로 중간에 held한 경쟁 재현 → 401.

## 4. B5 — blueprint 유니코드 우회 차단과 canonicalization 정책

- 검증은 NFKC + 임의 `\p{Nd}`→`0` folding을 거친 계산 문자열에서 수행: 전각
  숫자/＠/ｈｔｔｐ, 비라틴 숫자(Arabic-Indic·Devanagari·Math) 7연속,
  `\p{Cc}`·`\p{Cf}` 전체( zero-width, bidi embedding U+202A–U+202E, isolate
  U+2066–U+2069, BOM, soft hyphen, C1) 거부. 최대 길이도 canonical화 **후**
  기준으로 강제(`﷼`→`ريال` 팽창 탐지).
- 예외는 emoji ZWJ 시퀀스뿐(좌우가 pictographic/VS16일 때만 허용) — 한글·중점·
  일반 emoji 오탐 없음(accept/reject 테이블 테스트).
- 공개 작성자 표시명(`authorLabel`)은 **선택·빈값 허용**(main 결정 2026-10-06, base 81bc64a·UI "빈 설계도"와 일치 — 작성자 신원 수집 없음). 비어 있지
  않을 때만 위 유니코드/PII 검증이 적용되고, `title`·`name`·`category`는 기존대로 필수다(가이드 문서에 기록된 계약 드리프트는 백엔드 shared
  contract 원복으로 해소 — 프론트 가이드 문서는 손대지 않음).
- 저장은 작성 텍스트 원본(trim만 적용): canonicalization은 검증 뷰이며 작성자
  표기 선택을 보존한다. unknown key는 `.strict()` 그대로(조용한 strip 없음).
- 이메일/긴 번호 패턴 차단은 defense-in-depth이며 **완전 익명화가 아니다** —
  기존 mvp 문서의 경고(모든 개인정보 자동 판별 불가, 작성자 명시 검토 필수)를
  그대로 유지한다.

## 5. C10 — PUT 응답 대칭

`PUT /templates/:id`는 `POST`·목록과 동일하게 `{id, revision, blueprint, published}`를
반환하고 capability token을 어떤 경우에도 내려주지 않는다. `published`는 현재 활성
share 기준(pinned 발행본)으로 계산하며, draft 수정은 발행본을 바꾸지 않는다(테스트).

## 6. 검증 근거 (로컬 isolated Postgres)

- `pnpm --filter @living-cost-manager/shared test` → **158 passed / 0 failed** (reject 14종,
  authored-text accept 4종, authorLabel 선택(빈값 허용)+비어있을 때 검증, display 보존,
  canonical 길이·trim 경계 포함)
- `pnpm --filter @living-cost-manager/api test` → **251 passed / 0 failed, 16 files**
  (기존 239 + security 회귀 12: per-user 분리 61→429 & 타 사용자 200, 잘못된/폐기 토큰
  무소진 80req, token별·client별 분리, XFF 스푸핑 무효과(off)/loopback 신뢰 시 분리,
  malformed 공용 버킷, revoke 물리삭제·idempotent 204·재조회 404, injected-clock 만료
  경계(T-1ms 200 / T 404+소각), republish rotate 안전, B4 경쟁(행 잠금 held) 401,
  C10 무-token 대칭, 빈 authorLabel create→publish→공개/목록 왕복)
- 테스트 DB: 전용 isolated `lcm_test_db/lcm_test`(loopback, test-marker guard 통과;
  CI도 loopback test-marker DB 사용 확인). 프로덕션 DSN·OCI 미사용. API 스위트는
  시작 시 `migrate reset`으로 스키마를 초기화하므로 **같은 테스트 DB에서 두 API
  스위트를 병렬 실행하면 안 된다**(초기화가 진행 중 러닝 데이터를 삭제한다).

## 7. 남은 승인/판단 (Owner·main)

1. §1 read-only 게이트 수행 → `TRUST_PROXY` 값 확정(그 전에는 `off` 기본 배포)
   — 활성화는 gamja-ops env 재동기화 대상인 infra 변경.
2. §2 retention 문구 상한("조회 종료 vs 기회 소각")과 백업 회전 고려 여부 결정.
3. §N2 프록시/CF access log의 capability token 보존 확인 — 아래 N2 게이트.
4. 프로덕션 migration(`20261006160000_budget_templates`)·배포 승인 — 본 브랜치는
   코드·테스트·문서만 변경.

## N2 — capability URL 로그 게이트 (확인 전 "로그 없음" 주장 금지)

- 앱 계층: 템플릿·셰어 경로 요청 로깅 억제는 구현·테스트됨(`isTemplateRequest`,
  marketing과 같은 `disableRequestLogging` 경로).
- nginx 계층: 공개 조회 URL은 경로에 256-bit 토큰이 담기는 capability다. lcm
  라우트의 access_log 포맷· 보존 여부가 이 저장소 어디에도 검증 기록으로 없다 —
  §1의 `sudo nginx -T` read-only 확인으로 판단한다. 토큰이 기록되는 것이 확인되면
  마케팅 라우트 선례(`docs/marketing-release-20261005.md`: exact-location 승인 예외,
  `nginx -t`·해시 보존·diff 승인)와 동일 절차로 **좁은 location 예외**를 별도 승인으로
  검토하고, broad한 로그 축소는 하지 않는다(다른 라우트의 보안 로그 보존).
- Cloudflare 계층: 터널/엣지 log의 URI·헤더 보존·리텐션은 repo에서 검증 불가이고
  marketing 검증에서도 "CF security/network metadata는 여전히 처리될 수 있다, 403으로
  확인 불가"가 기록된 선례가 있다. 따라서 공유 링크를 "어디에도 남지 않는 비공개
  주소"로 설명하지 말고, **의도 수신자만 아는 capability URL**로 안내한다(복사·브라우저
  확장·서드파티 저장까지 통제 불가).
- 확인된 항목과 불가 항목을 배포 기록에 구분해 남긴다.
