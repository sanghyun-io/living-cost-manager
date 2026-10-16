# LCM CI Runner 보안 수정 완료 보고서

**작성일**: 2026-10-16  
**브랜치**: feat/ci-runner-a98c952d  
**커밋**: 550d512  
**상태**: ✅ 모든 P1/P2 blocker 해결 완료

---

## 📋 요약

Mac Mini self-hosted runner 설정에서 발견된 7개의 P1/P2 보안 문제를 모두 해결했습니다. 
변경사항은 로컬에서 검증 완료되었으며, GitHub Actions에 푸시하면 Owner의 sudo 권한으로 
runner를 프로비저닝할 수 있습니다.

---

## 🔒 해결된 보안 문제

### P1 (Critical) - 5건

#### 1. Root Symlink 공격 방지
**문제**: Root가 CI 사용자의 홈 디렉토리에 있는 실행 파일을 실행하면, CI 사용자가 
바이너리를 수정하여 root 권한으로 악성 코드를 실행할 수 있음 (TOCTOU 공격)

**해결**:
- Runner를 root-owned bundle (`/Library/Application Support/GamjaWorld/CI/lcm-production/`)과 
  CI-owned working dir (`/Users/lcm-ci/actions-runner/`)로 분리
- Bundle은 root만 쓰기 가능, CI 사용자는 읽기/실행만 가능
- LaunchDaemon plist가 bundle의 runsvc.sh를 가리키도록 변경
- Manifest 파일로 bundle 무결성 검증

**파일**:
- `scripts/ci/runner/00-bootstrap-bundle.sh` (신규)
- `scripts/ci/runner/02-register-runner.sh` (신규, 02-install-runner.sh 대체)
- `scripts/ci/runner/03-install-launchd.sh` (수정)
- `scripts/ci/runner/com.gamjaworld.lcm-ci-actions-runner.plist.template` (수정)

---

#### 2. PostgreSQL Trust 인증 제거
**문제**: `initdb -A trust`가 모든 연결(로컬 + TCP)에 대해 비밀번호 없이 접근을 허용하여, 
다른 OS 사용자가 DB superuser로 RCE 공격 가능

**해결**:
- TCP 리스너 비활성화 (`listen_addresses=''`)
- Unix socket만 사용 (0700 권한의 CI 소유 디렉토리)
- Peer auth로 로컬 연결만 허용 (OS 사용자 이름 = DB 역할 이름)
- TCP 연결은 명시적으로 거부 (`--auth-host=reject`)

**파일**:
- `scripts/ci/ephemeral-postgres.mjs` (수정)

---

#### 3. CI Workflow Guards 강화
**문제**: `workflow_dispatch`가 보호되지 않아 누구나 임의 브랜치에서 CI를 실행할 수 있음

**해결**:
- `ci.yml`에서 `workflow_dispatch` 제거 (push to main만 허용)
- Preflight job 추가: repo/ref/event/SHA 검증
- Fork 이벤트는 main에 push할 수 없으므로 자동으로 차단됨

**파일**:
- `.github/workflows/ci.yml` (수정)

---

#### 4. Protected Source 검증
**문제**: Deploy workflow가 CI 성공을 확인하지 않아 테스트되지 않은 코드가 배포될 수 있음

**해결**:
- `verify-ci` job 추가: GitHub API로 CI가 정확히 같은 SHA에서 성공했는지 확인
- `preflight` job 추가: actor가 Owner(sanghyun-io)인지 검증
- Deploy는 verify-ci와 preflight가 모두 통과한 경우에만 실행

**파일**:
- `.github/workflows/deploy-pages.yml` (수정)

---

#### 5. CI-Success-Gate 구현
**문제**: Deploy workflow가 CI와 다른 SHA를 배포할 수 있음

**해결**:
- `verify-ci` job이 GitHub API로 CI run의 head_sha를 조회
- Deploy SHA와 CI SHA가 정확히 일치하는지 검증
- 일치하지 않으면 deploy 중단

**파일**:
- `.github/workflows/deploy-pages.yml` (수정)

---

### P2 (High) - 2건

#### 6. Token 처리 개선
**문제**: Registration token이 argv나 stdin을 통해 노출될 수 있음

**해결**:
- Token을 `/dev/tty`에서 읽기 (hidden input)
- argv, stdin pipe, env 변수 사용하지 않음
- 사용 후 즉시 `unset`
- 05-remove.sh도 동일한 방식으로 token 처리

**파일**:
- `scripts/ci/runner/02-register-runner.sh` (신규)
- `scripts/ci/runner/05-remove.sh` (수정)

---

#### 7. npx 의존성 제거
**문제**: Deploy 단계에서 `npx wrangler`를 실행하면 네트워크에서 패키지를 다운로드하여 
supply chain 공격 가능

**해결**:
- `tools/wrangler/` 디렉토리에 wrangler 사전 설치
- `package-lock.json`으로 정확한 버전 고정 (4.131.1)
- Deploy workflow가 pre-install된 wrangler 사용
- Secret 단계에서 네트워크 접근 없음

**파일**:
- `tools/wrangler/package.json` (신규)
- `tools/wrangler/package-lock.json` (신규)
- `.github/workflows/deploy-pages.yml` (수정)

---

## 🧪 테스트 결과

### 보안 테스트 (신규)
```
Test Files  1 passed (1)
Tests       27 passed (27)
```

**테스트 카테고리**:
- Root symlink 보호 (6 tests)
- PG trust 보호 (4 tests)
- CI workflow guards (7 tests)
- Token 처리 (3 tests)
- Package-lock 격리 (5 tests)
- Owner home 보호 (2 tests)

### 기존 테스트 (모두 통과)
```
shared: 197 passed
web:    664 passed, 1 skipped
api:    461 passed (ephemeral Postgres)
```

---

## 📁 변경된 파일

### 신규 파일 (6개)
- `scripts/ci/runner/00-bootstrap-bundle.sh` - Root-owned bundle 생성
- `scripts/ci/runner/02-register-runner.sh` - Token을 /dev/tty에서 읽어서 runner 등록
- `scripts/ci/runner/security.test.ts` - 27개 보안 테스트
- `tools/wrangler/package.json` - Wrangler 의존성
- `tools/wrangler/package-lock.json` - Lock file

### 수정된 파일 (9개)
- `.github/workflows/ci.yml` - workflow_dispatch 제거, preflight job 추가
- `.github/workflows/deploy-pages.yml` - verify-ci/preflight job 추가, wrangler pre-install
- `scripts/ci/ephemeral-postgres.mjs` - Unix socket + peer auth
- `scripts/ci/runner/03-install-launchd.sh` - Bundle 경로 사용
- `scripts/ci/runner/04-verify.sh` - 새 경로 검증
- `scripts/ci/runner/05-remove.sh` - Precondition 검증 강화
- `scripts/ci/runner/README.md` - 새 아키텍처 문서화
- `scripts/ci/runner/com.gamjaworld.lcm-ci-actions-runner.plist.template` - Bundle 경로 사용
- `docs/ci-self-hosted-runner-20261016.md` - 보안 수정 요약 추가

### 삭제된 파일 (1개)
- `scripts/ci/runner/02-install-runner.sh` - 02-register-runner.sh로 대체

---

## 🚀 다음 단계 (Owner 작업)

### 1. Runner 프로비저닝 (sudo 필요)

```bash
# 1. CI 사용자 계정 생성
sudo scripts/ci/runner/01-create-account.sh

# 2. Root-owned bundle 생성
sudo scripts/ci/runner/00-bootstrap-bundle.sh

# 3. Runner 등록 (token은 /dev/tty에서 읽기)
sudo -u lcm-ci scripts/ci/runner/02-register-runner.sh
# 프롬프트에서 GitHub registration token 붙여넣기

# 4. LaunchDaemon 설치
sudo scripts/ci/runner/03-install-launchd.sh

# 5. 검증
sudo scripts/ci/runner/04-verify.sh
```

### 2. GitHub에 푸시

```bash
git push origin feat/ci-runner-a98c952d
```

### 3. Main에 머지 (PR 생성 후)

```bash
gh pr create --base main --head feat/ci-runner-a98c952d
# Owner가 PR 리뷰 후 머지
```

### 4. Secret 설정 (머지 후)

```bash
# Cloudflare API token 설정
gh secret set CLOUDFLARE_API_TOKEN --env production
gh secret set CLOUDFLARE_ACCOUNT_ID --env production
```

---

## 🔍 검증 방법

### GitHub Branch Protection 적용 (실제 API 호출)

```bash
# main 브랜치 보호 적용 (2026-10-16 실측)
gh api repos/sanghyun-io/living-cost-manager/branches/main/protection -X PUT \
  -f allow_force_pushes=false \
  -f allow_deletions=false \
  -f block_creations=false \
  -f required_linear_history=false \
  -f required_conversation_resolution=false \
  -f lock_branch=false \
  -f enforce_admins=false \
  --input - <<'EOF'
{
  "required_status_checks": null,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_linear_history": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "enforce_admins": false
}
EOF

# 적용 결과 확인
gh api repos/sanghyun-io/living-cost-manager/branches/main/protection
# {
#   "allow_force_pushes": {"enabled": false},
#   "allow_deletions": {"enabled": false},
#   "required_status_checks": null,
#   "required_pull_request_reviews": null
# }
```

**적용된 보호 규칙**:
- ✅ Force push 차단
- ✅ Branch deletion 차단
- ❌ Required status checks 없음 (CI가 main push에서만 실행되므로 deadlock 방지)
- ❌ Required PR reviews 없음 (solo owner는 self-approval 불가)

**주의**: Repository가 GitHub Free plan이므로 deployment branch policies는 지원되지 않음 (404).
대신 workflow 내부에서 `github.ref == 'refs/heads/main'` guard로 배포 제한.

### 로컬에서 보안 테스트 실행
```bash
cd /Users/sanghyun/services/lcm-ci-runner-20261016-a98c952d
./node_modules/.pnpm/node_modules/.bin/vitest run scripts/ci/runner/security.test.ts
```

### 전체 테스트 스위트 실행
```bash
# Shared
node scripts/ci/run-workspace-vitest.mjs packages/shared

# Web
node scripts/ci/run-workspace-vitest.mjs apps/web

# API (ephemeral Postgres 필요)
node scripts/ci/ephemeral-postgres.mjs start
node scripts/ci/run-workspace-vitest.mjs apps/api tsx tests/setup-test-db.ts
node scripts/ci/ephemeral-postgres.mjs stop
```

---

## 📊 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────────┐
│  Root-owned Bundle (Immutable)                              │
│  /Library/Application Support/GamjaWorld/CI/lcm-production │
│  ├─ bin/ (runner binaries)                                  │
│  ├─ externals/                                              │
│  ├─ config.sh                                               │
│  ├─ runsvc.sh                                               │
│  └─ manifest.txt (SHA-256 hashes)                           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  LaunchDaemon (root:wheel 0644)                             │
│  /Library/LaunchDaemons/com.gamjaworld.lcm-ci-...plist      │
│  ├─ Program: bundle/runsvc.sh (root-owned)                  │
│  ├─ WorkingDirectory: CI working dir                        │
│  └─ UserName: lcm-ci                                        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  CI-owned Working Directory (0700)                          │
│  /Users/lcm-ci/actions-runner                               │
│  ├─ .credentials (0600)                                     │
│  ├─ .env (0600)                                             │
│  ├─ _work/                                                  │
│  └─ _logs/                                                  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Root-owned Log Directory                                   │
│  /var/log/gamja-ci/lcm-production                           │
│  ├─ launchd.out.log (CI can write via ACL)                  │
│  └─ launchd.err.log (CI can write via ACL)                  │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚠️ 중요한 보안 특성

1. **TOCTOU 방지**: Root가 실행하는 바이너리는 CI 사용자가 수정 불가
2. **TCP 차단**: PostgreSQL은 Unix socket만 사용, TCP 연결 명시적 거부
3. **Token 보호**: 모든 token은 /dev/tty에서 읽기, argv/env 노출 없음
4. **Supply chain 보호**: Wrangler는 package-lock으로 고정, npx 사용 안 함
5. **CI 검증**: Deploy 전 CI 성공 확인, 정확한 SHA 일치 검증
6. **Actor 검증**: Deploy는 Owner(sanghyun-io)만 실행 가능

---

## 📚 참고 문서

- `scripts/ci/runner/README.md` - Runner 설치 가이드
- `docs/ci-self-hosted-runner-20261016.md` - 전체 CI/CD 전환 문서
- `scripts/ci/runner/security.test.ts` - 보안 테스트 소스

---

**완료 상태**: ✅ 모든 P1/P2 blocker 해결, 테스트 통과, 커밋 완료  
**다음 작업**: Owner의 sudo 권한으로 runner 프로비저닝
