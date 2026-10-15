"use client";

import type { MarketingConsentState } from "../lib/useMarketingConsent";

export function MarketingConsentControl({ consent, consentError, setEnabled }: MarketingConsentState) {
  return (
    <details style={{ marginTop: 16 }}>
      <summary style={{ cursor: "pointer", fontSize: "0.875rem", fontWeight: 600, padding: "8px 0", minHeight: 44 }}>
        개인정보·사용통계
      </summary>
      <section aria-label="개인정보·사용통계" style={{ padding: "8px 0" }}>
        <div id="marketing-consent-description">
          <p style={{ fontSize: "0.8rem", margin: "4px 0" }}>
            기본은 꺼짐이며 선택하지 않아도 서비스를 이용할 수 있습니다.
            목적: 서비스 개선. 범위: 서버에 연결되지 않은 내 데이터 공간의 빠른 추가·기준 납부일·갱신 결정 사용 여부.
            항목명·금액·이메일·계정 ID는 제외됩니다.
          </p>
          <p style={{ fontSize: "0.8rem", margin: "4px 0" }}>
            서버는 UTC 기준 일별 합계만 최대 90일 보관하며 운영자가 확인합니다.
            켜면 수집·전송을 시작하고, 끄면 미전송 작업과 진행 중 요청도 중단합니다.
            이미 합산된 수는 되돌릴 수 없습니다.
          </p>
          <p style={{ fontSize: "0.8rem", margin: "4px 0" }}>
            브라우저의 추적 거부 설정(GPC/DNT)을 우선합니다. 이 선택은 사용 통계 제공에만 적용되며,
            서비스 제공을 위한 인프라 접속 기록은 별도로 처리될 수 있습니다.
          </p>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, marginTop: 8, cursor: consent.browserOptOut ? "not-allowed" : "pointer" }}>
          <input
            type="checkbox"
            data-testid="marketing-consent"
            aria-describedby="marketing-consent-description"
            checked={consent.enabled}
            disabled={consent.browserOptOut}
            onChange={event => setEnabled(event.currentTarget.checked)}
          />
          사용 통계 제공에 동의합니다(선택)
        </label>

        {consentError && <p role="status" style={{ fontSize: "0.8rem", margin: "4px 0" }}>{consentError}</p>}

        {consent.browserOptOut && <p role="status" style={{ fontSize: "0.8rem", margin: "4px 0" }}>브라우저의 추적 거부 설정(GPC/DNT)에 따라 사용 통계 제공이 차단되어 있습니다.</p>}
      </section>
    </details>
  );
}
