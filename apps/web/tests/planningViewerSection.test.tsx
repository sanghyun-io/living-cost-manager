// @vitest-environment jsdom
// P2-6: 신선한 뷰어는 서버 공유 계획의 실제 금액을 읽을 수 있어야 한다
// (count 전용 표시 금지), 편집/PUT 수단은 없고 개인 설정 경로는 불변.
import { afterEach, describe, expect, test, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { PlanningSyncSection } from "../app/components/modals/PlanningSyncSection";
import type { PlanningProps } from "../app/lib/pageTypes";

const base: PlanningProps = {
  hasWorkspace: true,
  isViewer: true,
  canUpload: false,
  saveError: "",
  isBusy: false,
  serverSupport: "available",
  serverConfirmed: false,
  planningActive: false,
  serverDirty: false,
  hasRemoteDivergence: true,
  conflict: false,
  lastPlanningSyncedAt: null,
  statusMessage: "",
  localSummary: { weekCount: 0, reserveCount: 0, paydayDay: null },
  remoteStaged: {
    weekCount: 2,
    reserveCount: 1,
    paydayDay: 25,
    checkedAt: new Date("2026-10-19T06:00:00Z"),
    rows: [{ label: "10/19", budget: 100000, spent: 45000 }],
    reserveRows: [{ label: "자동차보험", saved: 30000, target: 600000 }]
  },
  onCheck: vi.fn(),
  onUpload: vi.fn(),
  onUploadOverwrite: vi.fn(),
  onAdoptRemote: vi.fn(),
  onCloseComparison: vi.fn(),
  onRetrySave: vi.fn()
};

function render(props: Partial<PlanningProps> = {}) {
  return renderToStaticMarkup(
    React.createElement(MantineProvider, null, React.createElement(PlanningSyncSection, { ...base, ...props }))
  );
}

afterEach(() => vi.restoreAllMocks());

describe("PlanningSyncSection — 뷰어 읽기 경로", () => {
  test("서버 주/준비금의 실제 금액이 표시된다(count-only 아님)", () => {
    const html = render();
    expect(html).toContain("₩100,000");
    expect(html).toContain("₩45,000");
    expect(html).toContain("₩30,000");
    expect(html).toContain("₩600,000");
    expect(html).toContain("자동차보험");
    expect(html).toContain("급여일 25");
  });

  test("뷰어에게 업로드/교체 수단이 없고 읽기 적용(표시)과 확인만 있다", () => {
    const html = render();
    expect(html).not.toContain("계획 서버 저장");
    expect(html).not.toContain("내 기록으로 서버 저장");
    expect(html).toContain("서버 기록을 이 기기에 표시(읽기)");
    expect(html).toContain("서버 기록 확인");
  });

  test("닫힌 발산(교체 권한 없음)은 재확인 요구로 표시된다", () => {
    const html = render({ remoteStaged: null, hasRemoteDivergence: true });
    expect(html).toContain("서버 기록 상이");
    expect(html).toContain("다시 확인");
    expect(html).not.toContain("교체");
  });
});
