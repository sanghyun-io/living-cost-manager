"use client";

import { useEffect, useState } from "react";
import { abortInFlightMarketingEvents, disableMarketing, subscribeMarketingRevocation } from "../lib/marketing";
import { enableMarketingConsent, readMarketingConsent } from "../lib/marketingConsent";

export function MarketingConsentControl() {
  const [consent, setConsent] = useState({ enabled: false, scope: null as string | null, browserOptOut: false });
  const [consentError, setConsentError] = useState("");
  const revocationWarning = "이 탭의 전송은 중단했지만 브라우저에 해제를 저장하지 못했습니다. 다른 탭과 다시 연 페이지까지 해제되었다고 보장할 수 없습니다. 다른 탭을 닫고 사이트 저장소를 지우거나 GPC/DNT를 켜세요.";
  useEffect(() => {
    const refresh = () => {
      const next = readMarketingConsent();
      // Observing OFF must not revoke consent granted by another tab. Only an
      // explicit toggle or browser opt-out revokes shared storage consent.
      if (next.browserOptOut) disableMarketing();
      else if (!next.enabled) abortInFlightMarketingEvents();
      setConsent(readMarketingConsent());
    };
    refresh();
    const unsubscribe = subscribeMarketingRevocation((persisted) => {
      setConsent(readMarketingConsent());
      if (!persisted) setConsentError(revocationWarning);
    });
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    return () => { unsubscribe(); window.removeEventListener("storage", refresh); window.removeEventListener("focus", refresh); };
  }, []);
  return (
    <section aria-label="선택적 중앙 집계" style={{ padding: "12px 0", minWidth: 0, overflowWrap: "anywhere" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, cursor: consent.browserOptOut ? "not-allowed" : "pointer" }}>
        <input type="checkbox" data-testid="marketing-consent" aria-describedby="marketing-consent-description" checked={consent.enabled} disabled={consent.browserOptOut}
          onChange={(event) => {
            setConsentError("");
            if (event.currentTarget.checked) {
              const next = enableMarketingConsent();
              setConsent(next);
              if (!next.enabled && !next.browserOptOut) setConsentError("동의를 저장하지 못해 중앙 집계는 꺼진 상태입니다. 브라우저 저장소 설정을 확인하세요.");
            } else {
              if (!disableMarketing()) setConsentError(revocationWarning);
              setConsent(readMarketingConsent());
            }
          }} />{" "}
        선택적 중앙 집계에 동의 (기본 꺼짐)
      </label>
      {consentError && <p role="status">{consentError}</p>}
      <p id="marketing-consent-description" style={{ fontSize: "0.8rem", margin: "4px 0" }}>
        제품의 사용성과 실제 가치를 확인하기 위한 선택적 집계입니다. 기존 온디바이스 사용 통계와 별개로,
        동의 시 서버에 연결되지 않은 개인 공간의 유효한 빠른 추가(이름·명시한 금액)·기준 납부일·갱신 결정 저장 성공 이벤트 이름만 전송합니다.
        이름·금액·계정 ID는 보내지 않습니다. 서버는 원시 이벤트 대신 UTC 기준 일별 익명 합계만 최대 90일 보관하며 운영자만 확인합니다.
        빈 행 추가·일반 수동 등록·샘플·서버 연결 공간·가져오기·과거 기록은 고정비 저장 집계에서 제외합니다. 이 브라우저의 동의 기간마다 종류별 첫 전송을 기록해 중복을 줄이지만 동시 탭에서는 중복 집계될 수 있습니다.
        사람 수·전환율·유지율이 아닙니다. 해제하면 미전송 작업을 버리며 이미 합산한 수는 되돌릴 수 없습니다.
        재동의·브라우저 변경·저장소 초기화 시 다시 집계될 수 있습니다. GPC/DNT 설정을 우선합니다.
        이 선택은 이 서비스의 중앙 집계에만 적용됩니다. 서비스 제공 인프라는 접속 메타데이터를 처리할 수 있습니다.
      </p>
      {consent.browserOptOut && <p role="status">브라우저의 GPC/DNT 설정에 따라 중앙 집계가 차단되어 있습니다.</p>}
    </section>
  );
}
