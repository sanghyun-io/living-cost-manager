import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as React from "react";
const hook = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, mounted: false, effect: undefined as undefined | (() => void | (() => void)) }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hook.cursor++;
    if (!(index in hook.values)) hook.values[index] = initial;
    return [hook.values[index], (value: unknown) => { hook.values[index] = value; }];
  },
  useEffect(effect: () => void | (() => void)) { if (!hook.mounted) { hook.mounted = true; hook.effect = effect; } }
}));
vi.mock("../app/lib/serverApi", () => ({ getServerApiBaseUrl: () => "https://api.example.test/v1" }));
import { MarketingConsentControl } from "../app/components/MarketingConsentControl";
import { useMarketingConsent } from "../app/lib/useMarketingConsent";
import { __resetMarketingConsentMemoryForTests, enableMarketingConsent, readMarketingConsent, MARKETING_CONSENT_STORAGE_KEY, MARKETING_CONSENT_SCOPE_STORAGE_KEY } from "../app/lib/marketingConsent";
import { disableMarketing, sendMarketingEvent } from "../app/lib/marketing";

let listeners: Map<string, () => void>;
let values: Map<string, string>;
let cleanup: void | (() => void);
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
beforeEach(() => {
  hook.values = []; hook.cursor = 0; hook.mounted = false; hook.effect = undefined; cleanup = undefined;
  __resetMarketingConsentMemoryForTests(); listeners = new Map(); values = new Map();
  // Vitest's TSX transform may use classic JSX; provide the real element factory.
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  }, addEventListener: vi.fn((name: string, fn: () => void) => listeners.set(name, fn)),
  removeEventListener: vi.fn((name: string) => listeners.delete(name)) });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(async () => { cleanup?.(); disableMarketing(); await flush(); vi.unstubAllGlobals(); });
function renderPageConsent() {
  hook.cursor = 0;
  const state = useMarketingConsent();
  if (hook.effect) { const effect = hook.effect; hook.effect = undefined; cleanup = effect(); }
  return state;
}
function render() {
  return MarketingConsentControl(renderPageConsent());
}
function findCheckboxInTree(tree: any): { checked: boolean; disabled: boolean; onChange: (event: { currentTarget: { checked: boolean } }) => void } | null {
  // Recursively search for input type="checkbox"
  if (tree?.props?.type === "checkbox") {
    return tree.props;
  }
  if (tree?.props?.children) {
    const children = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children];
    for (const child of children) {
      const found = findCheckboxInTree(child);
      if (found) return found;
    }
  }
  return null;
}

function checkbox() {
  const tree = render();
  const found = findCheckboxInTree(tree);
  if (!found) throw new Error("Checkbox not found");
  return found;
}

function errorMessage() {
  const tree = render();
  // Find the element with role="status" that's the consentError (not the browserOptOut message)
  // browserOptOut message contains "GPC/DNT" and "차단되어"
  function findError(node: any): any {
    if (node?.props?.role === "status") {
      const text = typeof node.props.children === "string" ? node.props.children : "";
      // The consentError contains "보장할 수 없습니다" but not "차단되어"
      if (text.includes("보장할 수 없습니다")) {
        return node;
      }
    }
    if (node?.props?.children) {
      const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
      for (const child of children) {
        const found = findError(child);
        if (found) return found;
      }
    }
    return null;
  }
  return findError(tree);
}

function getParagraphTexts(tree: any): string[] {
  const texts: string[] = [];
  function collectParagraphs(node: any) {
    if (node?.type === "p" && typeof node.props?.children === "string") {
      texts.push(node.props.children);
    }
    if (node?.props?.children) {
      const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
      for (const child of children) {
        collectParagraphs(child);
      }
    }
  }
  collectParagraphs(tree);
  return texts;
}
test("control starts unchecked, requires explicit toggle, and persists revocation", () => {
  expect(checkbox().checked).toBe(false);
  checkbox().onChange({ currentTarget: { checked: true } });
  expect(checkbox().checked).toBe(true);
  expect(readMarketingConsent().enabled).toBe(true);
  checkbox().onChange({ currentTarget: { checked: false } });
  expect(checkbox().checked).toBe(false);
  expect(values.has(MARKETING_CONSENT_STORAGE_KEY)).toBe(false);
});
test("passive OFF mount does not latch denial or revoke later cross-tab consent-on", async () => {
  render();
  expect(checkbox().checked).toBe(false);
  // Simulate another tab's writes, not enableMarketingConsent in this module:
  // that function would clear denyInMemory and hide the original regression.
  values.set(MARKETING_CONSENT_SCOPE_STORAGE_KEY, "other-tab-scope");
  values.set(MARKETING_CONSENT_STORAGE_KEY, "on");
  listeners.get("storage")!();
  expect(checkbox()).toMatchObject({ checked: true, disabled: false });
  expect(readMarketingConsent()).toMatchObject({ enabled: true, scope: "other-tab-scope" });
  expect(values.get(MARKETING_CONSENT_STORAGE_KEY)).toBe("on");
  expect(sendMarketingEvent("personal_cost_saved", { workspace: { sharedWorkspace: false } })).toBe(true);
  await flush(); expect(fetch).toHaveBeenCalledTimes(1);
});
test("privacy override discovered on focus unchecks, disables and cancels deferred work", async () => {
  enableMarketingConsent(); render(); expect(checkbox().checked).toBe(true);
  expect(sendMarketingEvent("personal_cost_saved", { workspace: { sharedWorkspace: false } })).toBe(true);
  vi.stubGlobal("navigator", { globalPrivacyControl: true }); listeners.get("focus")!();
  expect(checkbox()).toMatchObject({ checked: false, disabled: true });
  await flush(); expect(fetch).not.toHaveBeenCalled();
});
test("cross-tab storage revocation aborts active transport and effect cleanup removes listeners", async () => {
  enableMarketingConsent(); render();
  vi.mocked(fetch).mockReturnValue(new Promise(() => undefined));
  sendMarketingEvent("personal_cost_saved", { workspace: { sharedWorkspace: false } }); await flush();
  const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
  values.delete(MARKETING_CONSENT_STORAGE_KEY); listeners.get("storage")!();
  expect(checkbox().checked).toBe(false); expect(signal.aborted).toBe(true);
  cleanup?.(); cleanup = undefined;
  expect(listeners.size).toBe(0);
  expect(window.removeEventListener).toHaveBeenCalledTimes(2);
});

test("failed write AND removal visibly warn instead of claiming site-wide durable revocation", () => {
  render(); checkbox().onChange({ currentTarget: { checked: true } });
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw Error("readonly"); });
  vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => { throw Error("readonly"); });
  checkbox().onChange({ currentTarget: { checked: false } });
  expect(checkbox().checked).toBe(false);
  const warning = errorMessage();
  expect(warning).not.toBeNull();
  expect(warning.props.role).toBe("status");
  expect(warning.props.children).toContain("보장할 수 없습니다");
  expect(warning.props.children).toContain("GPC/DNT");
});

test("closed settings retain page-lifetime cross-tab revocation and abort transport", async () => {
  renderPageConsent();
  renderPageConsent().setEnabled(true);
  vi.mocked(fetch).mockReturnValue(new Promise(() => undefined));
  expect(sendMarketingEvent("personal_cost_saved", { workspace: { sharedWorkspace: false } })).toBe(true);
  await flush();
  const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
  // No control element rendered; only the page hook remains mounted.
  values.delete(MARKETING_CONSENT_STORAGE_KEY);
  listeners.get("storage")!();
  expect(signal.aborted).toBe(true);
  expect(renderPageConsent().consent.enabled).toBe(false);
  expect(checkbox().checked).toBe(false);
});
