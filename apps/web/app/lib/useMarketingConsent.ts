import { useEffect, useState } from "react";
import { abortInFlightMarketingEvents, disableMarketing, subscribeMarketingRevocation } from "./marketing";
import { enableMarketingConsent, readMarketingConsent } from "./marketingConsent";

// Page lifetime, not settings-dialog lifetime: cross-tab revocation must abort
// pending/in-flight transport even while the settings UI is closed.
export function useMarketingConsent() {
  const [consent, setConsent] = useState({ enabled: false, scope: null as string | null, browserOptOut: false });
  const [consentError, setConsentError] = useState("");
  const revocationWarning = "이 탭의 전송은 중단했지만 브라우저에 해제를 저장하지 못했습니다. 다른 탭과 다시 연 페이지까지 해제되었다고 보장할 수 없습니다. 다른 탭을 닫고 사이트 저장소를 지우거나 GPC/DNT를 켜세요.";
  useEffect(() => {
    const refresh = () => {
      const next = readMarketingConsent();
      if (next.browserOptOut) disableMarketing();
      else if (!next.enabled) abortInFlightMarketingEvents();
      setConsent(readMarketingConsent());
    };
    refresh();
    const unsubscribe = subscribeMarketingRevocation(persisted => {
      setConsent(readMarketingConsent());
      if (!persisted) setConsentError(revocationWarning);
    });
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    return () => { unsubscribe(); window.removeEventListener("storage", refresh); window.removeEventListener("focus", refresh); };
  }, []);
  function setEnabled(enabled: boolean) {
    setConsentError("");
    if (enabled) {
      const next = enableMarketingConsent();
      setConsent(next);
      if (!next.enabled && !next.browserOptOut) setConsentError("선택을 저장하지 못해 사용 통계 제공은 꺼진 상태입니다. 브라우저 저장소 설정을 확인하세요.");
    } else {
      if (!disableMarketing()) setConsentError(revocationWarning);
      setConsent(readMarketingConsent());
    }
  }
  return { consent, consentError, setEnabled };
}

export type MarketingConsentState = ReturnType<typeof useMarketingConsent>;
