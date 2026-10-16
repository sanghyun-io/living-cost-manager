import { describe, expect, test } from "vitest";
import {
  COACH_MODEL_APPROX_MB,
  COACH_MODEL_ENABLE_THINKING,
  COACH_MODEL_GENERATION,
  COACH_MODEL_ID,
  COACH_MODEL_VRAM_MB,
  getCoachModelBaseUrl
} from "../app/lib/coachModel";

describe("coachModel — 기본 모델 / 자원 상수", () => {
  test("COACH_MODEL_ID 는 Qwen3.5-0.8B (SDK 0.2.84 prebuilt 의 새 기본)", () => {
    expect(COACH_MODEL_ID).toBe("Qwen3.5-0.8B-q4f16_1-MLC");
  });

  test("approx/vram은 SDK prebuilt 의 권장치와 일치", () => {
    expect(COACH_MODEL_APPROX_MB).toBe(453);
    expect(COACH_MODEL_VRAM_MB).toBe(1629.49);
  });

  test("enable_thinking=false 가 기본 (think 블록 UI 노출 사고 차단)", () => {
    expect(COACH_MODEL_ENABLE_THINKING).toBe(false);
  });

  test("격려 패러프레이즈용 generation 파라미터는 옛 값과 동일하게 보존", () => {
    expect(COACH_MODEL_GENERATION.max_tokens).toBe(70);
    expect(COACH_MODEL_GENERATION.temperature).toBe(0.2);
    expect(COACH_MODEL_GENERATION.top_p).toBe(0.9);
    expect(COACH_MODEL_GENERATION.frequency_penalty).toBe(0.4);
    expect(COACH_MODEL_GENERATION.presence_penalty).toBe(0.2);
  });

  test("modelBaseURL override 는 모델-특정 검증을 통과해야만 적용", () => {
    // 옛 baseline URL (모델 ID 가 안 옛는) 은 null 로 폴백해야 새 weights 가 잘못
    // 가리키지 않는다.
    expect(getCoachModelBaseUrl("https://models.gamja.top/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/")).toBeNull();
    expect(getCoachModelBaseUrl(`https://models.gamja.top/${COACH_MODEL_ID}/`)).not.toBeNull();
  });
});