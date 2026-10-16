import { describe, expect, test } from "vitest";
import {
  looksLikeUnfinishedThink,
  stripQwenThink
} from "../app/lib/coachEngine/thinkPrefix";

describe("stripQwenThink — Qwen 3.5 사고 블록 정리", () => {
  test("닫힌 <think>...</think> 블록 전체 제거", () => {
    expect(stripQwenThink("<think>seed\n</think> 안녕하셔요.")).toBe("안녕하셔요.");
    expect(stripQwenThink("a<think>x</think>b")).toBe("ab");
  });

  test("여러 개의 닫힌 block 제거", () => {
    expect(stripQwenThink("<think>a</think><think>b</think>안녕")).toBe("안녕");
  });

  test("열렸지만 닫히지 않은 <think> 블록 폐기", () => {
    expect(stripQwenThink("<think>이건 끊긴 사고")).toBe("");
    expect(stripQwenThink("<think>a\n\n미완성")).toBe("");
  });

  test("분리된 시작 토큰 '<th' 처리", () => {
    expect(stripQwenThink("<th")).toBe("");
    expect(stripQwenThink("<th\n\n미완성")).toBe("");
    expect(stripQwenThink("<think\n\n미완성")).toBe("");
    // '<' 로 시작하는 split 형식도 잘 처리되어야 한다.
    expect(stripQwenThink("<th\n\nseed body")).toBe("");
  });

  test("본문이 없는 빈 <think>...</think> 도 안전", () => {
    expect(stripQwenThink("<think></think>")).toBe("");
    expect(stripQwenThink("<think>  \n</think>")).toBe("");
  });

  test("think 흔적이 전혀 없으면 그대로 반환", () => {
    expect(stripQwenThink("그냥 한 문장입니다.")).toBe("그냥 한 문장입니다.");
    expect(stripQwenThink("")).toBe("");
  });
});

describe("looksLikeUnfinishedThink — split 토큰 감지", () => {
  test("앞이 <th 로 시작하면 true", () => {
    expect(looksLikeUnfinishedThink("<th")).toBe(true);
    expect(looksLikeUnfinishedThink("<think")).toBe(true);
    expect(looksLikeUnfinishedThink("  <think")).toBe(true);
  });

  test("정상 응답은 false", () => {
    expect(looksLikeUnfinishedThink("그냥 한 문장")).toBe(false);
    // 닫힌 think 블록을 통과한 응답 (strip 후) 은 false.
    expect(looksLikeUnfinishedThink(" 정상")).toBe(false);
    expect(looksLikeUnfinishedThink("")).toBe(false);
  });
});