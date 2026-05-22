# Living Cost Manager

생활비와 고정비를 관리하는 Next.js 기반 웹 앱입니다.

## Features

- 사용자별 로컬 로그인
- 월 수입 입력 및 수입 대비 고정비 요약
- 고정비 항목 편집 및 주기별 월 환산 계산
- 카테고리 관리 및 카테고리 필터
- 결제수단/결제옵션 관리
- 신용카드 결제일 기반 납부일 자동 반영
- 카드 관리
- 막대/원형 차트 기반 카테고리별 비중 확인
- CSV 템플릿 export/import
- `.lcm` 전체 백업 export/import
- GitHub Pages 정적 배포
- 브라우저 localStorage 자동 저장 상태 표시
- PWA manifest 및 오프라인 캐시

## Development

```bash
pnpm install
pnpm dev
```

## Checks

```bash
pnpm test
pnpm build
```

## Notes

The app currently stores user data in browser localStorage. Do not use it as a production finance system without adding server-side authentication, persistence, and backup controls.
