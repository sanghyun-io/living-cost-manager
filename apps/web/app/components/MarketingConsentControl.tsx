"use client";

import type { MarketingConsentState } from "../lib/useMarketingConsent";

export function MarketingConsentControl({ consent, consentError, setEnabled }: MarketingConsentState) {
  return (
    <section aria-label="개인정보와 사용 통계" style={{ padding: "12px 0", minWidth: 0, overflowWrap: "anywhere" }}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 8px" }}>개인정보와 사용 통계</h2>
      <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, cursor: consent.browserOptOut ? "not-allowed" : "pointer" }}>
        <input type="checkbox" data-testid="marketing-consent" aria-describedby="marketing-consent-description" checked={consent.enabled} disabled={consent.browserOptOut}
          onChange={event => setEnabled(event.currentTarget.checked)} />{" "}
        서비스 개선을 위한 사용 통계 제공(선택)
      </label>
      {consentError && <p role="status">{consentError}</p>}
      <p id="marketing-consent-description" style={{ fontSize: "0.8rem", margin: "4px 0" }}>
        기본은 꺼짐이며, 선택하지 않아도 서비스를 이용할 수 있습니다. 등록·납부일 설정·갱신 결정 기능이 도움이 되는지 확인하기 위한 통계입니다.
        켜면 서버에 연결되지 않은 내 데이터 공간에서 빠른 추가·기준 납부일·갱신 결정이 새로 저장됐다는 사실만 전송합니다.
        항목명·금액·이메일·계정 ID는 보내지 않습니다. 과거 기록이나 아래의 개인 기기 통계를 업로드하지 않습니다.
      </p>
      <details style={{ fontSize: "0.8rem" }}>
        <summary>제공 범위와 보관·해제 안내</summary>
        <p>서버는 개별 이벤트 기록 대신 UTC 기준 일별 합계만 최대 90일 보관하며 운영자가 확인합니다.
          빈 행 추가·일반 수동 등록·샘플·서버 연결 공간·가져오기는 고정비 등록 집계에서 제외합니다.
          이 브라우저의 동의 기간마다 종류별 첫 전송만 기록해 중복을 줄이지만 동시 탭·재동의·브라우저 변경·저장소 초기화 시 다시 집계될 수 있습니다.
          이 수치는 사람 수·전환율·유지율이 아닙니다.</p>
        <p>해제하면 이후 전송을 중단하고 미전송 작업을 버리며 진행 중인 요청을 중단합니다. 이미 서버에 도착해 합산된 수는 되돌릴 수 없습니다.
          브라우저의 추적 거부 설정(GPC/DNT)을 우선합니다. 이 선택은 이 서비스의 사용 통계 제공에만 적용되며 서비스 제공 인프라는 접속 메타데이터를 처리할 수 있습니다.</p>
      </details>
      {consent.browserOptOut && <p role="status">브라우저의 추적 거부 설정(GPC/DNT)에 따라 사용 통계 제공이 차단되어 있습니다.</p>}
    </section>
  );
}
