// @vitest-environment jsdom
import type { ComponentProps, PropsWithChildren } from "react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CoachModal } from "../app/components/modals/CoachModal";
import { AppHeader } from "../app/components/AppHeader";
vi.mock("../app/components/modals/ModalShell", () => ({ ModalShell: ({ children }: PropsWithChildren) => <div role="dialog">{children}</div> }));
afterEach(cleanup);
function props(overrides: Partial<ComponentProps<typeof CoachModal>> = {}): ComponentProps<typeof CoachModal> {
  return {
    opened: true, webGpuAvailable: true, preferencesReady: true, hasData: true,
    approxMb: 453, vramMb: 1629.49, modelName: "Qwen3.5-0.8B-q4f16_1-MLC", status: "idle",
    loadProgress: 0.416, loadText: "", coaching: "", errorMessage: "", fallbackHeadline: "",
    awaitingConsent: false, preparationState: "ready", onStart: vi.fn(), onRegenerate: vi.fn(),
    onClose: vi.fn(), onConfirmConsent: vi.fn(), onContinueWithoutPreparation: vi.fn(),
    onGenerateCoaching: vi.fn(), onCancelPreparation: vi.fn(), ...overrides
  };
}
it("ready models cannot expose generation or download consent while protection preferences are unavailable", () => {
  const input = props({ preferencesReady: false, awaitingConsent: true });
  render(<MantineProvider><CoachModal {...input} /></MantineProvider>);
  expect(screen.queryByRole("button", { name: "코칭 보기" })).toBeNull();
  expect(screen.queryByRole("button", { name: "동의하고 AI 준비" })).toBeNull();
  expect(input.onGenerateCoaching).not.toHaveBeenCalled();
});
it("preparing exposes a continue action that closes only the modal, with rounded progress", () => {
  const input = props({ preparationState: "preparing", status: "loading" });
  render(<MantineProvider><CoachModal {...input} /></MantineProvider>);
  expect(screen.getByText("42%")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다른 작업 계속하기" }));
  expect(input.onContinueWithoutPreparation).toHaveBeenCalledOnce();
  expect(input.onCancelPreparation).not.toHaveBeenCalled();
  expect(input.onGenerateCoaching).not.toHaveBeenCalled();
});

it("keeps preparation failure discoverable after the modal closes without automatically retrying", () => {
  const openCoach = vi.fn();
  const input: ComponentProps<typeof AppHeader> = {
    saveError: "", onRetrySave: vi.fn(), onExportUnsaved: vi.fn(),
    recoveryRequired: false, lastSavedAt: null, serverSession: null,
    currentUserName: undefined, onOpenData: vi.fn(), onOpenAuth: vi.fn(),
    onOpenCoach: openCoach, onOpenTemplates: vi.fn(), onServerLogout: vi.fn(),
    coachHeaderIndicator: "error"
  };
  const ui = render(<MantineProvider><AppHeader {...input} /></MantineProvider>);
  expect(openCoach).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "AI 준비 실패 · 확인" }));
  expect(openCoach).toHaveBeenCalledOnce();
  ui.rerender(<MantineProvider><AppHeader {...input} coachHeaderIndicator="none" /></MantineProvider>);
  expect(screen.queryByRole("button", { name: "AI 준비 실패 · 확인" })).toBeNull();
});
