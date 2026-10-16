// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedCostTable } from "../app/components/FixedCostTable";
import { createFixedCost, updateFixedCost, type FixedCost } from "../app/lib/budget";
import { emptyCostFilters } from "../app/lib/costViews";

// jsdom has no layout observer; no production component or name handler is mocked.
beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const noop = () => {};
function Harness({ scope = "A", progress = 0, focusRequest = 0, externalName }: {
  scope?: string; progress?: number; focusRequest?: number; externalName?: string;
}) {
  const [items, setItems] = useState<Record<string, FixedCost>>(() => ({
    A: createFixedCost({ id: "same-row-id", name: "Original A", amount: 1000, billingDay: 1 }),
    B: createFixedCost({ id: "same-row-id", name: "Other B", amount: 2000, billingDay: 1 })
  }));
  const [writes, setWrites] = useState<string[]>([]);
  useEffect(() => {
    if (externalName !== undefined) setItems(previous => ({ ...previous, [scope]: updateFixedCost(previous[scope], { name: externalName }) }));
  }, [scope, externalName]);
  const item = items[scope];
  return <MantineProvider>
    <div data-testid="progress">{progress}</div>
    <output data-testid="canonical">{item.name}</output>
    <output data-testid="writes">{JSON.stringify(writes)}</output>
    <output data-testid="ledger-a">{items.A.name}</output>
    <output data-testid="ledger-b">{items.B.name}</output>
    <button onClick={noop}>다른 작업</button>
    <FixedCostTable key={scope}
      focusItemId={focusRequest ? item.id : null} focusRequest={focusRequest}
      costFilters={emptyCostFilters} onCostFilters={noop} onResetFilters={noop}
      categories={[{ id: "other", label: "기타" }]} cards={[]}
      visibleFixedCosts={[item]} visibleFixedCostTotal={item.amount}
      categoryFilterId="all" isDeleteMode={false} selectedDeleteIds={[]} importMessage=""
      onItemChange={(_id, patch) => {
        // Keep the real production normalization and per-change commit rhythm.
        setItems(previous => ({ ...previous, [scope]: updateFixedCost(previous[scope], patch) }));
        setWrites(previous => [...previous, scope]);
      }}
      onPaymentMethodChange={noop} onPaymentOptionChange={noop} onAddItem={noop}
      onDuplicateItem={noop} onEnterDeleteMode={noop} onCancelDeleteMode={noop}
      onConfirmDeleteItems={noop} onToggleDeleteSelection={noop} onFilterChange={noop}
      onOpenCategory={noop} onOpenCard={noop} onOpenData={noop}
    />
  </MantineProvider>;
}
function nameInput() { return screen.getByRole<HTMLInputElement>("textbox", { name: "항목명" }); }
function canonical() { return screen.getByTestId("canonical").textContent; }
function writes(): string[] { return JSON.parse(screen.getByTestId("writes").textContent ?? "[]"); }
function focus(input: HTMLInputElement) { act(() => input.focus()); }

it("sequential typing without clearing first preserves Synthetic Latest B instead of joining its words", () => {
  render(<Harness />);
  const input = nameInput(); focus(input);
  const intended = "Synthetic Latest B";
  for (let index = 0; index < intended.length; index++) {
    const value = index === 0 ? intended[index] : input.value + intended[index];
    fireEvent.change(input, { target: { value } });
    expect(input.value).toBe(intended.slice(0, index + 1));
    expect(canonical()).toBe(intended.slice(0, index + 1).trim());
  }
  expect(writes()).toHaveLength(intended.length);
});

it.each(["Synthetic Latest B", "  Synthetic  Latest B  ", "보험 생활 보장", "  보험  생활 보장  "])(
  "preserves every typed character of %j across parent progress renders while committing each canonical change",
  intended => {
    const h = render(<Harness />);
    const input = nameInput();
    focus(input);
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(canonical()).toBe("새 항목");
    let expected = "";
    for (const [index, char] of [...intended].entries()) {
      // Append to the actual DOM value, as sequential browser typing does.
      fireEvent.change(input, { target: { value: input.value + char } });
      expected += char;
      expect(input.value).toBe(expected);
      expect(canonical()).toBe(expected.trim() || "새 항목");
      expect(writes()).toHaveLength(index + 2);
      h.rerender(<Harness progress={index + 1} />);
      expect(nameInput()).toBe(input);
      expect(input.value).toBe(expected);
      expect(document.activeElement).toBe(input);
    }
    const writeCount = writes().length;
    act(() => input.blur());
    expect(input.value).toBe(intended.trim());
    expect(canonical()).toBe(intended.trim());
    expect(writes()).toHaveLength(writeCount); // blur never writes the budget
  }
);

it("keeps an empty/whitespace-only field editable, without changing the domain's fallback or adding blur writes", () => {
  render(<Harness />);
  const input = nameInput(); focus(input);
  fireEvent.change(input, { target: { value: "" } });
  expect(input.value).toBe(""); expect(canonical()).toBe("새 항목");
  fireEvent.change(input, { target: { value: "   " } });
  expect(input.value).toBe("   "); expect(canonical()).toBe("새 항목");
  act(() => input.blur());
  expect(input.value).toBe("새 항목"); expect(writes()).toHaveLength(2);
  focus(input);
  expect(input.value).toBe("새 항목");
  fireEvent.change(input, { target: { value: "새 이름" } });
  expect(input.value).toBe("새 이름"); expect(canonical()).toBe("새 이름");
});

it("reflects external canonical names immediately while blurred and never replaces a focused draft on rerender", () => {
  const h = render(<Harness />);
  h.rerender(<Harness externalName="  가져온 이름  " />);
  const input = nameInput();
  expect(input.value).toBe("가져온 이름");
  focus(input);
  fireEvent.change(input, { target: { value: "내 입력 " } });
  h.rerender(<Harness progress={42} externalName="  외부 갱신 이름  " />);
  expect(input.value).toBe("내 입력 ");
  expect(canonical()).toBe("외부 갱신 이름");
  act(() => input.blur());
  expect(input.value).toBe("외부 갱신 이름");
  expect(writes()).toEqual(["A"]);
});

it("scope-keyed table remount drops a focused old draft even when row IDs are reused, with no blur writes to the new ledger", () => {
  const h = render(<Harness />);
  const oldInput = nameInput(); focus(oldInput);
  fireEvent.change(oldInput, { target: { value: "  A draft " } });
  h.rerender(<Harness scope="B" />);
  const newInput = nameInput();
  expect(newInput).not.toBe(oldInput);
  expect(newInput.value).toBe("Other B");
  expect(writes()).toEqual(["A"]);
  expect(screen.getByTestId("ledger-a").textContent).toBe("A draft");
  expect(screen.getByTestId("ledger-b").textContent).toBe("Other B");
  focus(newInput);
  fireEvent.change(newInput, { target: { value: "B fresh name" } });
  expect(screen.getByTestId("ledger-b").textContent).toBe("B fresh name");
  expect(screen.getByTestId("ledger-a").textContent).toBe("A draft");
  expect(writes()).toEqual(["A", "B"]);
});

it("preserves forwarded input focus/select requests and seeds refocused drafts from the current canonical name", () => {
  const h = render(<Harness />);
  h.rerender(<Harness focusRequest={1} />);
  const input = nameInput();
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length);
  fireEvent.change(input, { target: { value: " New keyboard name " } });
  expect(input.value).toBe(" New keyboard name ");
  act(() => screen.getByRole("button", { name: "다른 작업" }).focus());
  expect(input.value).toBe("New keyboard name");
  h.rerender(<Harness focusRequest={2} />);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("New keyboard name");
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length);
  fireEvent.change(input, { target: { value: input.value + " 추가" } });
  expect(canonical()).toBe("New keyboard name 추가");
  expect(writes()).toHaveLength(2);
});
