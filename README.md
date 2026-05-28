# Living Cost Manager

생활비와 고정비를 관리하는 모노레포 프로젝트입니다. 프론트엔드는 GitHub Pages에 정적 파일로 배포하고, 공유/동기화 기능은 별도의 API 서버와 Postgres를 사용합니다.

## 모노레포 구조

```text
apps/
  web/      Next.js 정적 export 프론트엔드
  api/      Fastify API 서버
packages/
  shared/   웹과 API가 함께 쓰는 Zod 스키마와 타입
prisma/     Prisma schema와 migration
```

루트 `package.json`에서 pnpm workspace를 관리합니다.

## 로컬 웹 개발

```bash
pnpm install
pnpm dev
```

웹 앱만 직접 실행하려면 다음 명령을 사용합니다.

```bash
pnpm --filter @living-cost-manager/web dev
```

기본 확인 명령은 다음과 같습니다.

```bash
pnpm test
pnpm build
```

GitHub Pages 프론트엔드는 계속 정적 export 방식입니다. 서버 공유 기능을 사용할 빌드에서는 웹 빌드 시점에 `NEXT_PUBLIC_API_BASE_URL`을 API 공개 URL로 설정해야 합니다.

## 프론트 배포 제공자 호환성

프론트엔드는 정적 export 결과물만 배포하므로 GitHub Pages와 Cloudflare Pages 모두 같은 구조로 배포할 수 있습니다. 호스팅 제공자에 종속되는 서버 코드는 프론트에 두지 않고, API origin은 빌드 시점 환경 변수 하나로만 주입합니다.

```text
NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1
```

Cloudflare Pages로 옮길 때도 빌드 명령은 `pnpm --filter @living-cost-manager/web... build`, 출력 디렉터리는 `apps/web/out`을 사용합니다. 변경해야 하는 값은 Cloudflare Pages 프로젝트 변수의 `NEXT_PUBLIC_API_BASE_URL`과 API 서버의 `CORS_ORIGIN` 허용 origin뿐입니다. GitHub Pages와 Cloudflare Pages를 동시에 열어두는 동안에는 API 서버에서 두 origin을 명시적으로 허용하도록 설정해야 합니다.

## 로컬 API/Postgres 개발

로컬 Postgres는 개발용 Compose 파일로 실행합니다.

```bash
docker compose -f docker-compose.dev.yml up -d
```

API 환경 변수는 `apps/api/.env.example`을 참고해 로컬 셸이나 실행 도구에서 프로세스 환경 변수로 주입합니다. 실제 비밀값은 커밋하지 않습니다.

```bash
pnpm db:generate
pnpm db:migrate
pnpm --filter @living-cost-manager/api dev
```

API 테스트와 전체 테스트에서 DB 연동 테스트를 실행하려면 `API_TEST_DATABASE_URL`이 필요합니다. 같은 Postgres 데이터베이스를 쓰더라도 Prisma schema는 분리하세요.

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/living_cost_manager?schema=lcm
API_TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/living_cost_manager?schema=lcm_test
```

`API_TEST_DATABASE_URL`은 테스트 시작 시 `prisma migrate reset --force`를 실행합니다. 따라서 앱이 쓰는 `lcm` schema가 아니라 반드시 `lcm_test`처럼 `test`가 포함된 테스트 전용 schema를 지정해야 합니다.

## OCI/백엔드 배포 개요

API 컨테이너는 `apps/api/Dockerfile`로 빌드합니다. 운영 Compose 예시는 `docker-compose.prod.yml`입니다.

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm api ./node_modules/.bin/prisma migrate deploy
docker compose -f docker-compose.prod.yml up -d
```

컨테이너 시작 명령은 migration을 자동 실행하지 않습니다. 새 버전을 올리기 전에 `prisma migrate deploy`를 먼저 실행하는 전략을 사용하세요.

OCI의 기존 PostgreSQL 인스턴스를 사용할 때는 `docker-compose.oci.yml`을 사용합니다. 이 Compose 파일은 API 컨테이너만 실행하고, `.env.oci`에서 `DATABASE_URL`과 `JWT_SECRET`을 읽습니다. `.env.oci`는 절대 커밋하지 않습니다.

```bash
docker compose -f docker-compose.oci.yml build api
docker compose -f docker-compose.oci.yml run --rm api ./node_modules/.bin/prisma migrate deploy
docker compose -f docker-compose.oci.yml up -d api
```

현재 VM은 Docker 없이 systemd 서비스로 운영할 수 있습니다. repo 관리형 배포 절차는 `scripts/deploy-oci-api.ps1`에 있으며, 비밀값은 로컬 셸 환경 변수로만 전달합니다.

```powershell
$env:LCM_DATABASE_URL = "<credentials sheet에서 읽은 값>"
$env:LCM_JWT_SECRET = "<충분히 긴 JWT secret>"
pnpm deploy:oci-api -- -WriteEnv
```

평상시 코드만 갱신할 때는 `-WriteEnv` 없이 실행합니다. 이 스크립트는 원격에서 `git fetch`, `pnpm install`, API build, `prisma migrate deploy`, systemd 재시작, 내부/public health 확인을 순서대로 수행합니다. 비밀값은 출력하지 않습니다.

현재 OCI API gateway에서는 공개 API base URL을 다음 형식으로 둡니다.

```text
https://api.gamja.top/living-cost-manager/v1
```

운영 환경에서는 `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`를 배포 환경의 비밀 관리 방식으로 주입합니다. Prisma schema는 서비스용 `lcm`, 테스트용 `lcm_test`처럼 분리해서 운영하세요. `JWT_SECRET`, DB 비밀번호, credentials가 포함된 API URL을 README, Compose 파일, Git 커밋, 로그에 남기지 마세요.

OCI나 VM에서는 Docker Compose로 API와 Postgres를 실행하고, 외부 공개는 Nginx, Caddy, OCI Load Balancer 같은 HTTPS reverse proxy 뒤에 두는 구성을 권장합니다. Reverse proxy에서 TLS를 종료하고 API origin을 고정한 뒤, API의 `CORS_ORIGIN`을 GitHub Pages 프론트엔드 URL 또는 허용할 정확한 웹 origin으로 설정하세요.

## 워크스페이스 공유

로그인 후 데이터 관리 패널의 "공유 관리"에서 워크스페이스를 다른 사용자와 공유합니다. 멤버에게는 `owner`, `editor`, `viewer` 권한을 줄 수 있습니다.

| 작업 | 권한 | API |
|------|------|-----|
| 멤버 목록 조회 | owner / editor / viewer | `GET /workspaces/:workspaceId/members` |
| 멤버 권한 변경 | owner | `PATCH /workspaces/:workspaceId/members/:memberId` |
| 멤버 제거 | owner | `DELETE /workspaces/:workspaceId/members/:memberId` |
| 초대 생성 | owner | `POST /workspaces/:workspaceId/invitations` |
| 보낸 초대 목록 조회 | owner | `GET /workspaces/:workspaceId/invitations` |
| **초대 취소** | owner | `DELETE /workspaces/:workspaceId/invitations/:invitationId` |
| 받은 초대 목록 조회 | 본인 | `GET /invitations` |
| 초대 수락 | 본인 | `POST /invitations/:invitationId/accept` |

### 초대 흐름

1. owner가 이메일과 권한(`viewer`/`editor`)으로 초대를 생성하면, 초대 링크 토큰이 발급됩니다.
2. 초대받은 사용자는 같은 이메일로 로그인한 뒤 "받은 초대"에서 토큰으로 수락합니다.
3. owner는 "공유 관리 > 보낸 초대"에서 아직 수락되지 않은(pending) 초대를 확인하고 "취소"할 수 있습니다.

### 초대 취소(revoke)

owner는 아직 수락되지 않은 초대를 언제든 취소할 수 있습니다.

- 취소는 **soft delete**입니다. 초대 행을 지우지 않고 상태(`status`)를 `revoked`로 바꿔 감사 이력을 남깁니다.
- 취소된 초대의 토큰은 **더 이상 수락할 수 없습니다.** 수락 요청은 `404`로 거부됩니다(수락은 `pending` 상태만 허용).
- 취소는 멱등합니다. 이미 취소된(또는 존재하지 않는) 초대를 다시 취소하면 `404`를 반환합니다.
- 같은 이메일로 다시 초대하면 새 초대 행이 생성되며, 이전에 취소/수락된 이력은 재초대를 막지 않습니다.

초대의 `status`는 `pending`, `accepted`, `revoked`, `expired` 중 하나이며 `WorkspaceInvitationDto`에 포함됩니다.

## 공개 배포 smoke

공개 API와 Pages 연결은 아래 명령으로 확인합니다.

```powershell
pnpm smoke:public
```

이 smoke는 공개 API에 disposable 계정과 워크스페이스를 만들고, 로그인, `/me`, 워크스페이스 조회, snapshot PUT/GET, 초대/수락까지 확인합니다. 현재 공개 API에는 마지막 owner 계정/워크스페이스 삭제 엔드포인트가 없으므로 smoke 데이터는 남습니다. 운영 DB 정리는 별도 DB/schema maintenance 절차로 처리합니다.

## 참고

브라우저 localStorage 기반 기능은 정적 프론트엔드에서 계속 동작합니다. 공유/동기화 기능은 API 서버, Postgres, 올바른 빌드 시점 `NEXT_PUBLIC_API_BASE_URL`이 준비된 경우에만 사용할 수 있습니다.
