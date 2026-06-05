import { Alert, Button, Group, Progress, Stack, Text } from "@mantine/core";

import { ModalShell } from "./ModalShell";

export type CoachStatus = "idle" | "loading" | "generating" | "ready" | "error";

interface CoachModalProps {
  opened: boolean;
  webGpuAvailable: boolean;
  hasData: boolean;
  approxMb: number;
  status: CoachStatus;
  // 0..1 다운로드/초기화 진행률.
  loadProgress: number;
  loadText: string;
  coaching: string;
  errorMessage: string;
  // 규칙 기반 폴백 한 줄(WebGPU 미지원 또는 보조 표시용).
  fallbackHeadline: string;
  onStart: () => void;
  onRegenerate: () => void;
  onClose: () => void;
}

export function CoachModal({
  opened,
  webGpuAvailable,
  hasData,
  approxMb,
  status,
  loadProgress,
  loadText,
  coaching,
  errorMessage,
  fallbackHeadline,
  onStart,
  onRegenerate,
  onClose
}: CoachModalProps) {
  const busy = status === "loading" || status === "generating";

  return (
    <ModalShell opened={opened} sectionLabel="AI 코치" title="이번 달 가계부 코칭" onClose={onClose}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          기기 안에서 직접 동작하는 작은 AI가 고정비 데이터를 보고 조언해 드려요. 데이터는 기기 밖으로
          나가지 않고, 인터넷 없이도 동작합니다.
        </Text>

        {!webGpuAvailable ? (
          <Alert variant="light" color="yellow" title="이 브라우저에서는 AI 코치를 쓸 수 없어요">
            WebGPU를 지원하는 최신 브라우저(데스크톱 Chrome/Edge 등)에서 사용할 수 있어요. 대신 간단 요약을
            보여드릴게요.
            {fallbackHeadline ? (
              <Text size="sm" mt="xs" fw={600}>
                {fallbackHeadline}
              </Text>
            ) : null}
          </Alert>
        ) : !hasData ? (
          <Alert variant="light" color="teal">
            아직 코칭할 고정비 데이터가 부족해요. 항목을 추가하면 이번 달 패턴을 분석해 드릴게요.
          </Alert>
        ) : (
          <>
            {status === "idle" ? (
              <Alert variant="light" color="teal" title={`처음 한 번만 약 ${approxMb}MB를 내려받아요`}>
                Wi-Fi 환경을 권장해요. 한 번 받으면 기기에 저장되어 다음부터는 즉시, 오프라인으로 동작합니다.
              </Alert>
            ) : null}

            {status === "loading" ? (
              <Stack gap={6}>
                <Text size="sm">AI 모델을 준비하고 있어요… (처음 1회)</Text>
                <Progress value={Math.round(loadProgress * 100)} color="teal" radius="xl" striped animated />
                <Text size="xs" c="dimmed">
                  {loadText || `${Math.round(loadProgress * 100)}%`}
                </Text>
              </Stack>
            ) : null}

            {(status === "generating" || status === "ready") && coaching ? (
              <Alert variant="light" color="teal" title="AI 코치">
                <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                  {coaching}
                  {status === "generating" ? " ▍" : ""}
                </Text>
              </Alert>
            ) : null}

            {status === "error" ? (
              <Alert variant="light" color="rose" title="코칭을 불러오지 못했어요">
                {errorMessage || "잠시 후 다시 시도해 주세요."}
                {fallbackHeadline ? (
                  <Text size="sm" mt="xs" fw={600}>
                    {fallbackHeadline}
                  </Text>
                ) : null}
              </Alert>
            ) : null}

            <Group justify="flex-end" gap="sm">
              {status === "ready" ? (
                <Button variant="default" radius="xl" onClick={onRegenerate} disabled={busy}>
                  다시 코칭받기
                </Button>
              ) : (
                <Button
                  variant="gradient"
                  gradient={{ from: "teal.6", to: "teal.4", deg: 120 }}
                  radius="xl"
                  onClick={onStart}
                  loading={busy}
                  disabled={busy}
                >
                  {status === "idle" ? "AI 코치 켜기" : "준비 중…"}
                </Button>
              )}
            </Group>
          </>
        )}
      </Stack>
    </ModalShell>
  );
}
