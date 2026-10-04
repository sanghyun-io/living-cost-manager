# 로컬 사용성 검증

## 단일 명령

```sh
pnpm verify:usability
```

설치된 pnpm 의존성, PostgreSQL 도구(`initdb`, `pg_ctl`, `createdb`), Chromium을 포함한 Playwright가 필요하다. shared 선행 build와 Prisma client 생성은 명령이 수행한다.

Playwright는 루트의 버전 고정 devDependency를 사용한다. `pnpm install --frozen-lockfile` 후 `pnpm exec playwright install chromium`으로 브라우저를 준비한다. `PLAYWRIGHT_MODULE`로 설치된 모듈을 재정의할 수 있다. PostgreSQL 도구 경로는 `PG_BIN`, 브라우저 실행 파일은 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`로 지정할 수 있다.

임시 루트는 OS `tmpdir()` 기본값이며 `LCM_TEST_TEMP_ROOT`로 지정할 수 있다. OpenCode에서는 해당 세션이 안내한 승인 임시 루트를 지정한다. 매 실행마다 새 `lcm-usability-test-*` 디렉터리를 만든다.

## 수행 내용

1. 임의의 사용 가능한 loopback 포트에 목적 전용 PostgreSQL cluster를 시작한다. DB/user/schema는 `lcm_test`이다. 5432/5433은 제외한다. 호출자의 `DATABASE_URL`과 운영 provider 환경변수를 상속하지 않는다. `LCM_VERIFY_CLUSTER_MARKER`는 새 임시 디렉터리의 `ownership.json`이며 DB/API/web URL과 초기화된 PG_VERSION을 대조한다. API 브라우저 픽스처는 이 표식 없이는 실행되지 않는다.
2. 소유권 guard 2개와 shared/web/API 전체 테스트를 수행한다. 기존 API reset은 이 명령이 만든 임시 DB에만 실행된다. API 테스트 자체도 loopback 및 database/schema의 test 이름을 검사한다.

   `scripts/verification-target.test.mjs`는 러너가 만든 cluster 환경을 필요로 하므로 위 단일 명령 안에서 실행한다.
3. 전체 production build와 service worker 회귀를 실행한다.
4. 빌드된 정적 웹과 API를 loopback에 띄운다. Chromium 1440/390에서 열 가지 사용성 기능, 기존 로컬 데이터 보존 및 실제 로컬 API 동기화/충돌/계정 삭제를 회귀 검증한다. 브라우저의 외부 요청은 차단된다.
5. 성공/실패 모두 `finally`에서 자식 프로세스와 웹 서버를 종료하고 PostgreSQL을 중지한 뒤 목적 전용 임시 디렉터리를 제거한다. SIGINT/SIGTERM은 작업을 실패 처리하고 POSIX 자식 프로세스 그룹에 종료를 전달한다. 실행 파일 누락도 대기 없이 실패한다. DB 중지 실패 시 증거 디렉터리를 보존하고 실패한다.

테스트나 build/browser 단계 실패는 0이 아닌 종료 코드로 전파된다.

### 수락 조건과 테스트 연결

| 기능 | 회귀 근거 |
|---|---|
| 저장 재시도 | `budgetUsability.test.ts` quota 실패/프로필 저장 차단 + 브라우저 quota 주입·미저장 다운로드·재시도 |
| 검색·필터·정렬 | `costViews.test.ts` 조합/빈 결과/원본 불변/미확인 날짜 마지막 + 브라우저 빈 결과·초기화 |
| 복제 | `costViews.test.ts` 청구 보존·절감 초기화·원본 불변 + 브라우저 새 ID·포커스 |
| 삭제 취소 | `budgetUsability.test.ts` 후속 편집·프로필/교체 경계 + 브라우저 삭제→다른 행 편집→복원 |
| 빠른 입력 | `quickAdd.test.ts` 파싱/누락/상한 + hook 무효 입력 + 브라우저 IME·입력 보존 |
| 접근성 | hook 필터 해제/포커스 대상 + 브라우저 Tab 건너뛰기·행 포커스·닫기/파일 이름·390px 터치 영역 |
| 일정 안내 | `scheduleHelp.test.ts` 기준일 누락/소수 주기/윤년·평년 말일 + 기존 billing 회귀 |
| 갱신 검토 | `costViews.test.ts` 상태 전이·청구/절감 불변 + 브라우저 임박 작업에서 직접 편집 |
| 가져오기 | `budgetUsability.test.ts` 손상/취소/편집/느린 파일/프로필 왕복/선택 경쟁 + 브라우저 미리보기·적용 |
| 검증 DX | 단일 명령 전체 실행 + DB 이후 의도적 실패의 exit/정리 확인 |

정리 경로 확인용:

```sh
LCM_VERIFY_INJECT_FAILURE=after-db pnpm verify:usability
```

이 명령은 의도적으로 실패하고 임시 PostgreSQL 종료/삭제 메시지를 출력해야 한다. 운영 배포/공개 서비스 접근은 포함하지 않는다. 산출물 `apps/web/out`, 패키지 `dist`는 일반 로컬 build 결과이다.

## 복구 사본 보존

새 `:recovery:v1:import:`와 `:recovery:v1:corrupt:` 네임스페이스에서만 종류별 최근 3개를 보존한다. 손상 원본은 가공 없이 저장하고 동일 원본의 반복 사본은 만들지 않는다. quota 실패 시 가장 최근 기존 사본을 남기고 더 오래된 관리 대상 사본만 정리하여 재시도한다. 그래도 실패하면 가져오기를 중단한다. 기존/알 수 없는 키와 과거 백업은 자동 삭제하지 않는다. 저장소의 동기 확인·쓰기에는 탭 간 원자적 CAS 보장이 없으며, 가져오기 효과에서의 지연 재저장은 하지 않는다.
