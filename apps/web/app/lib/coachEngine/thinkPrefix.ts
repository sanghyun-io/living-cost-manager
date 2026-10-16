// Qwen3.5 모델이 출력에 섞어 보내는 비-생성 토큰 정리.
//
// 배경:
// - Qwen 계열은 `<think>...</think>` 같은 사적 추론 블록을 본문 앞에 끼워 보내는
//   경우가 있다. 본 프로젝트는 패러프레이즈 한 문장만 UI 에 노출하므로 추론
//   흔적은 모두 제거해야 한다.
// - 또한 model 이 잘려서(스트리밍 도중 connection 끊김, 토큰 상한 등) `<think>`
//   블록이 닫히지 않은 상태로 도착할 수 있다. 이 경우 `</think>` 가 없으면
//   추론 블록 전체를 폐기해야 UI 가 영문/기호 노출 사고를 내지 않는다.
// - 마지막으로 Qwen3.5 는 가끔 빈 `<think></think>` 블록을 가장 앞에 붙인다.
//   이 경우 단순 trim 으로는 제거되지 않으므로 선행 정규식 한 번에 정리한다.

/**
 * Qwen3.5 think 블록을 제거한다.
 * - 닫힌 블록(`<think>...</think>`) 전체 제거.
 * - 열렸지만 닫히지 않은 블록(`<think>...` 본문 끝까지)도 제거.
 *   → UI 에 영문/기호 사고가 노출되지 않게.
 * - 본문 중간에 등장하는 split 토큰(예: "<th", "<think") 도 처리.
 *       `<th` 로 시작해서 `>` 로 닫히는 토큰(예: `<th\n...>`)은 거의
 *       항상 미완성 think 토큰이므로 폐기.
 */
export function stripQwenThink(text: string): string {
  if (!text) return text;
  // 가장 앞에 붙은 빈/잔여 <think>...</think> 블록 제거 (greedy).
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  // 끝까지 닫히지 않은 <think> 블록도 폐기.
  out = out.replace(/<think>[\s\S]*$/, "");
  // split 형식: '<th...' 또는 '<think...' 시작 (괄호가 끊긴 상태 포함) → 끝까지 폐기.
  out = out.replace(/<\s*th(?:ink)?(?:>|\b)[\s\S]*$/, "");
  // trim 으로 사고 흔적 줄바꿈까지 정리.
  return out.replace(/^\s+/, "");
}

/**
 * Qwen 모델은 출력 시작에 종종 `<think>` 태그를 일부만 만들고 멈추는
 * 경우가 있다 (예: "<th", "<think"). 이 두 케이스를 모두 감지해 전체 출력을
 * 빈 문자열로 만든다. 정상 응답으로 위화되는 사고를 차단.
 */
export function looksLikeUnfinishedThink(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trimStart();
  return trimmed.startsWith("<th") || trimmed.startsWith("<think");
}