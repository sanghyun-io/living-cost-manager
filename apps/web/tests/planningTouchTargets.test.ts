import { expect, test } from "vitest";
import { readFileSync } from "node:fs";

// N21(≤560px 터치 타깃 44)는 실제 Chrome 실측이 정본이지만, 회귀 방지는
// 스타일시트 계약으로 잠금: 새 계획 패널 가족 버튼/입력/요약은 모바일에서
// min-height 44px 이상이어야 하고 40px 잔존을 허용하지 않는다.
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function mediaBlocks(): string {
  const marker = "@media (max-width: 560px)";
  let cursor = 0;
  const blocks: string[] = [];
  for (;;) {
    const idx = css.indexOf(marker, cursor);
    if (idx < 0) break;
    let depth = 0;
    let end = idx;
    for (let i = css.indexOf("{", idx); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") depth--;
      if (depth === 0) { end = i; break; }
    }
    blocks.push(css.slice(idx, end));
    cursor = end;
  }
  if (blocks.length === 0) throw new Error("≤560 media block missing");
  return blocks.join("\n");
}

test("mobile planning-panel family guarantees 44px touch targets", () => {
  const block = mediaBlocks();
  for (const selector of [
    ".weekly-budget-panel .mantine-Button-root",
    ".reserve-panel .mantine-Button-root",
    ".month-review .mantine-Button-root",
    ".weekly-budget-panel .mantine-Input-input",
    ".reserve-panel .mantine-Input-input",
    ".month-review .mantine-Input-input",
    ".weekly-budget-history summary",
    ".month-review > summary"
  ]) {
    expect(block).toContain(selector);
  }
  expect(block).toContain("min-height: 44px");
  expect(block).toContain("min-width: 44px");
  // 계획 패널 규칙에 40px로 되돌린 라인이 섞이면 실패(기존 표/헤더 규칙은 별개).
  const planningLines = block.split("\n").filter(line =>
    /weekly-budget|reserve-panel|month-review/.test(line));
  expect(planningLines.every(line => !line.includes("40px"))).toBe(true);
});

test("global Mantine sizing untouched: no blanket 44px rules outside the scoped families", () => {
  // 전역 선택자만으론 계획 패널 외 페이지가 44px로 강제되지 않는다(요청 범위).
  const blanket = /^\.mantine-Button-root\s*\{\s*min-height:\s*44px/m;
  expect(blanket.test(css)).toBe(false);
});
