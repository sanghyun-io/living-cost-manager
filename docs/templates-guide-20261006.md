# 템플릿 공유 UX 리뷰 대응 및 공개 안내 가이드 (2026-10-06)

- 작성: frontend (feat/templates-20261006, base `81bc64a`)
- 상태: 로컬 검증 완료. push/deploy 하지 않음 — main 코드/보안/테스터 검토 및 프로덕션 DB 명시 승인 대기.
- 이 문서의 공개 가이드 문구는 위 조건이 충족되어 같은 버전으로 배포된 이후의 상태를 설명한다. 배포 전에는 "/guide/templates/"가 프로덕션에 존재하지 않는다.

## 독립 리뷰에서 요구된 프론트엔드 수정

### 1. 저장 후 입력 금액/수입 유지 (TemplateModal)
- 기존: 저장이 완료되면 `choose(saved.blueprint, saved)`가 적용용 금액과 수입을 초기화했다.
- 수정: `alignTemplateAmounts`/`templateItemsUnchanged`(apps/web/app/lib/templates.ts)가 항목의 정규 신원(trim+NFKC의 canonical key)과 stable index를 비교해, 서버 응답이 표기 정규화만 차이가 나는 경우 금액을 그대로 유지한다. 신원이 실제로 달라진 항목만 해당 칸이 비워져 stale 금액이 다른 항목에 적용되는 경로를 차단한다. 수입은 항목에 의존하지 않으므로 유지된다.
- 항목 추가/삭제/편집 중에는 기존처럼 amounts 배열을 함께 재지수화한다.
- 금액·수입은 브라우저 상태에만 존재하며 POST 바디(blueprint, revision)와 공유 설계도에 포함되지 않는다.
- 실패/성공 응답이 늦게 도착해도 계정·토큰·연결 순서 가드로 stale apply를 방지한다.

### 2. C8: 서버 연결 중 "이전 공간으로 돌아가기" 무반응
- 기존: `returnFromTemplate()`이 서버 세션이 있으면 아무 말 없이 종료했다.
- 수정: 복귀 대상 유효성(존재·미삭제·활성 포인터 일치)을 먼저 검증하고, 서버 세션이 있으면 confirm()로 연결 해제 동의를 받은 뒤에만 해제·복귀한다. 취소 시 메시지("서버 연결을 유지하여…")를 반환해 main 상태 영역에 role=alert로 표시한다. 삭제된 프로필·교차계정 stale 포인터는 복원하지 않고 현재 공간을 유지하며, 세션 secret은 어떤 저장 키에도 복사되지 않는다.

### 3. C7: templateError가 부팅 화면에서만 렌더링
- 수정: templateError는 정상 대시보드 상단(main 내, role=alert)과 부팅 화면 양쪽에서 렌더링한다. apply 실패 시 모달은 닫고 페이지 단일 알림으로 표시해 중복 다이얼로그를 없앴다. 템플릿 모달 열기 시 정리(cleanup)한다. 모달 내 상태도 심각도에 따라 `role=alert`/`role=status`를 구분한다.

### 4. 잘못된 #template 프래그먼트 시나리오
- `parseTemplateShareFragment`/`isTemplateShareToken`(apps/web/app/lib/templateApi.ts)이 43자 base64url 형태를 서버 요청 전에 검증한다. 빈 값·공백 포함·초장문·유니코드 등은 API 요청 0건, 원문(PII일 수 있는 URL 값)을 UI에 반복 표시하지 않는 고정 문구, replaceState로 죽은 프래그먼트 제거(뒤로 가기 보존), 다이얼로그를 열지 않고 main 상태 영역에 안내한다.
- 형태는 유효하나 조회 실패(만료·철회·오프라인)인 경우에만 모달이 열리고, 시나리오 내용을 미리 채우지 않는 빈 껍데기로 표시하며 단일 role=alert와 안내 문구, 회복 경로(상황별 시작점)를 제공한다.

## 검증 근거 (2026-10-06, 로컬)
- 단위: apps/web/tests/templateDraft.test.ts 9건(금액 유지/공백 원칙/프래그먼트 검증/요청 없음), apps/web/tests/useLocalUsersTemplateReturn.test.ts 6건(계정 경계·확인 없는 disconnect 없음·secret 복사 없음), 기존 templates.test.ts 8건 포함 focused 23건 통과.
- 웹 스위트 전체: 20 files / 233 tests 통과, tsc --noEmit 통과.
- build: next build(16.2.6, static export) 성공, /guide/templates/ prerender, sitemap 자동 반영.
- 브라우저 proof(actors 없는 localhost static export, chromium headless): malformed 4종(초장문·%20·유니코드·빈값)에서 다이얼로그 0개 / 고정 문구 1개(role=alert) / 원문 비노출 / 해시 제거 / 외부 요청 0건, 43자 유효 형태 + API 없음에서 중립 비활성 모달 + alert 1개 + 적용/게시 비활성 + 시나리오 회복. evidence: tmp-screenshots/(gitignored).
- 테스트·빌드는 base 커밋에서 빌드된 packages/shared/dist(md5 templates.js 4a37fe5bea8d5d3311c1c190e652a78d) 기준. 백엔드 에이전트가 shared/api를 수정 중이라 재빌드하지 않았고, 유지보수 테스터가 머지 후 전체 스위트와 API 연동 시나리오를 재검증해야 한다.

## 공개 가이드 문장 정책 (apps/web/app/guide, /guide/templates/)
- 담기는 것과 남기는 것: 이름·카테고리·주기만. 금액·수입·납부일·카드·계정·거래 기록 비포함. 빈칸≠0, 0은 명시 입력.
- 공개 링크는 로그인 여부와 무관하게 아는 사람 누구나 — public이지 anonymous 보장이 아니다. 재유포 통제 불가.
- 만료·철회는 이후 조회를 차단한다(90일 접근 만료). 이미 복사한 설계도·공간은 회수하지 않는다. 서버 보관 데이터의 물리 삭제 시점은 특정 시한으로 약속하지 않는다(백엔드의 revoke 시 삭제 처리 확정 후에도 "접근 차단 기준" 문구를 유지).
- 장터·판매·수익 정산·라이선스 기능 없음. 서비스 구독 요금은 준비 중(planned)이며 템플릿과 별개. 원본성·재배포 권리는 작성자 확인 사항이며 법적 판단은 전문가 검토가 필요하다.
- OG/메타데이터는 가이드 제목·설명과 정적 social.png만 사용하고 템플릿 작성자명·공유 토큰을 생성하지 않는다. 대시보드는 noindex이고 공유 능력은 URL 프래그먼트에 있어 크롤러가 요청하지 않는다.

## 남은 것 (this agent scope 밖)
- main 승인 후 머지·배포, security 리뷰, full-suite 통합(유지보수 테스터), 프로덕션 DB 승인, 리텐션 백엔드 삭제 정책 확정 시 문구 재확인.
