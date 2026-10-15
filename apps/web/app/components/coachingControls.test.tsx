// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { CoachingPreferencesPanel } from "./CoachingPreferencesPanel";
import { InsightsPanel } from "./InsightsPanel";
import type { FixedCost } from "../lib/budget";

afterEach(cleanup);
const items = [{ id: "a", name: "항목A", amount: 10000, periodMonths: 1, categoryId: "subscription", billingAnchorDate: null, renewalStatus: "unreviewed" },
  { id: "b", name: "항목B", amount: 20000, periodMonths: 1, categoryId: "subscription", billingAnchorDate: null, renewalStatus: "unreviewed" }] as FixedCost[];

it("corrupt-storage warning is visible outside collapsed details; every preference control is disabled", () => {
  const toggle = vi.fn(); const save = vi.fn(); const load = vi.fn();
  render(<MantineProvider><CoachingPreferencesPanel items={items} prefs={{ schemaVersion: 1, revision: 0, protectedItems: [] }} activeIds={new Set()} toggle={toggle} setReason={vi.fn()} ready={false} status="원본을 보존하고 편집·동기화를 차단했습니다." busy={false} dirty canCloudAccess save={save} load={load} /></MantineProvider>);
  expect(screen.getByRole("alert").closest("details")).toBeNull();
  const check = screen.getByLabelText("항목A 유지 설정") as HTMLInputElement;
  expect(check.disabled).toBe(true);
  fireEvent.click(check);
  expect(toggle).not.toHaveBeenCalled();
  expect(screen.getByText("서버에서 불러오기").closest("button")?.disabled).toBe(true);
  expect(screen.getByText("서버에 저장").closest("button")?.disabled).toBe(true);
});

it("recommendation keep action names its exact actionable item and removes it on protection update", () => {
  const keep = vi.fn();
  const props = { fixedCosts: items, asOf: new Date("2026-10-15T00:00:00Z"), monthlyIncome: 100000, monthlyExpense: 30000, onKeepItem: keep };
  const h = render(<MantineProvider><InsightsPanel {...props} protectedFixedCostIds={new Set()} /></MantineProvider>);
  const buttons = screen.getAllByRole("button", { name: "항목B 유지", hidden: true });
  fireEvent.click(buttons[0]);
  expect(keep).toHaveBeenCalledWith("b");
  h.rerender(<MantineProvider><InsightsPanel {...props} protectedFixedCostIds={new Set(["b"])} /></MantineProvider>);
  expect(screen.queryByRole("button", { name: "항목B 유지", hidden: true })).toBeNull();
});

it("unknown protection readiness suppresses savings but retains upcoming billing, totals and later normal recommendations", () => {
  const keep = vi.fn();
  const dueItems = items.map(item => ({ ...item, billingAnchorDate: "2026-10-20", billingDay: 20, isEndOfMonth: false }));
  const props = { fixedCosts: dueItems, asOf: new Date("2026-10-15T00:00:00Z"), monthlyIncome: 100000, monthlyExpense: 30000, onKeepItem: keep };
  const h = render(<MantineProvider><InsightsPanel {...props} coachingPreferencesReady={false} /></MantineProvider>);
  expect(screen.getByText("내 코칭 설정을 확인할 수 없어 절감 제안을 보류했습니다.")).toBeTruthy();
  expect(screen.queryByText("아낄 수 있는 곳")).toBeNull();
  expect(screen.queryAllByRole("button", { name: /유지$/, hidden: true })).toHaveLength(0);
  expect(screen.getByText("가까운 납부 · 최대 5건")).toBeTruthy();
  expect(screen.getByText("항목A")).toBeTruthy(); expect(screen.getByText("항목B")).toBeTruthy();
  const totalsBefore = h.container.querySelector(".due-total")?.textContent;
  expect(totalsBefore).toContain("30,000");
  h.rerender(<MantineProvider><InsightsPanel {...props} coachingPreferencesReady /></MantineProvider>);
  expect(screen.queryByText("내 코칭 설정을 확인할 수 없어 절감 제안을 보류했습니다.")).toBeNull();
  expect(screen.getByText("아낄 수 있는 곳")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "항목B 유지", hidden: true }).length).toBeGreaterThan(0);
  expect(h.container.querySelector(".due-total")?.textContent).toBe(totalsBefore);
});

it("SSR explicitly reports unavailable protection settings instead of rendering savings actions", () => {
  const html = renderToStaticMarkup(<MantineProvider><InsightsPanel fixedCosts={items} monthlyIncome={100000} monthlyExpense={30000} coachingPreferencesReady={false} onKeepItem={vi.fn()} /></MantineProvider>);
  expect(html).toContain("내 코칭 설정을 확인할 수 없어 절감 제안을 보류했습니다.");
  expect(html).not.toContain("아낄 수 있는 곳");
  expect(html).not.toContain("항목B 유지");
});
