import type { BillingSdk, SdkRequest } from "./types";

type PortOne = { requestIssueBillingKey(request: SdkRequest): ReturnType<BillingSdk["issue"]> };
let loading: Promise<PortOne> | undefined;
// Official distribution: https://developers.portone.io/sdk/ko/v2-sdk/readme
// This adapter is called only after controller readiness, quote, and user consent.
export const portOneSdk: BillingSdk = {
  async issue(request) {
    if (!loading) loading = new Promise<PortOne>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.portone.io/v2/browser-sdk.js";
      script.async = true;
      script.referrerPolicy = "no-referrer";
      const timer = setTimeout(() => { script.remove(); reject(new Error("SDK unavailable")); }, 15000);
      script.onload = () => {
        clearTimeout(timer);
        const sdk = (window as Window & { PortOne?: PortOne }).PortOne;
        if (typeof sdk?.requestIssueBillingKey === "function") resolve(sdk);
        else reject(new Error("SDK unavailable"));
      };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error("SDK unavailable")); };
      document.head.appendChild(script);
    }).catch(error => { loading = undefined; throw error; });
    const sdk = await loading;
    // No redirect callback containing a key in the URL is supported here.
    return sdk.requestIssueBillingKey(request);
  }
};

// Explicit local mock adapter. It never loads a script or calls a provider.
export function browserBillingSdk(hostname: string): BillingSdk {
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  return { supportsMock: local, issue(request, mode) {
    if (mode === "mock") {
      if (!local) return Promise.reject(new Error("Mock unavailable"));
      return Promise.resolve({ billingKey: `mock_${request.issueId}` });
    }
    return portOneSdk.issue(request, mode);
  } };
}
