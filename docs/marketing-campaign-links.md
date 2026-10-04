# 캠페인 링크 준비

게시·발송은 별도 Owner 승인 후 진행한다. 이 도구는 링크 문자열만 만든다.

```sh
node scripts/marketing/campaign-url.mjs renewal-checklist community renewal
```

- 캠페인: `renewal-checklist`, `billing-calendar`, `local-first`
- 출처: `community`, `newsletter`, `social`, `interview`
- 목적지: `guide`(기본), `billing`, `renewal`, `backup`, `faq`
- 개인별 링크·이메일·이름·검색어·자유 입력은 지원하지 않는다.
- UTM은 링크 운영 규칙일 뿐이다. 현재 중앙 이벤트와 연결하거나 전환율을 산출하지 않는다. 외부 도구에서 실제 제공되는 집계가 확인되기 전까지 캠페인 성과는 **미측정**이다.
- URL의 쿼리는 브라우저 및 기존 웹 인프라에서 처리될 수 있다. 민감 정보를 수동으로 추가하지 않는다.

외부 내보내기, 인터뷰 원본, 생성 보고서는 gitignored `marketing-private/` 아래 보관한다. 이 경로는 접근 제어 자체가 아니므로 공유하지 않는 로컬 계정/디렉터리에서 `umask 077`로 작업한다. `docs/marketing/`에는 고객 기록을 넣지 않는다.
