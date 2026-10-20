import { Alert, Button, Group, Progress, Stack, Text } from "@mantine/core";

import { ModalShell } from "./ModalShell";

export type CoachStatus = "idle" | "loading" | "generating" | "ready" | "error";

interface CoachModalProps {
  opened: boolean;
  webGpuAvailable: boolean;
  preferencesReady?: boolean;
  hasData: boolean;
  approxMb: number;
  vramMb: number;
  modelName: string;
  status: CoachStatus;
  // 0..1 다운로드/초기화 진행률.
  loadProgress: number;
  loadText: string;
  coaching: string;
  errorMessage: string;
  // 규칙 기반 폴백 한 줄(WebGPU 미지원 또는 보조 표시용).
  fallbackHeadline: string;
  // 동의 대기 중 여부 (idle 상태에서 동의 필요)
  awaitingConsent: boolean;
  // 외부 store 의 준비 상태.
  preparationState: "idle" | "preparing" | "ready" | "cancelled" | "error";
  onStart: () => void;
  onRegenerate: () => void;
  onClose: () => void;
  // 동의 / 시작 / 취소 / 재시도 콜백
  onConfirmConsent?: () => void;
  onContinueWithoutPreparation: () => void;
  onCancelPreparation?: () => void;
  onRetryPreparation?: () => void;
  // 준비 완료 후 모달 안에서 명시적으로 코칭을 생성.
  onGenerateCoaching?: () => void;
}

export function CoachModal({
  opened,
  webGpuAvailable,
  preferencesReady = true,
  hasData,
  approxMb,
  vramMb,
  modelName,
  status,
  loadProgress,
  loadText,
  coaching,
  errorMessage,
  fallbackHeadline,
  awaitingConsent,
  preparationState,
  onStart,
  onRegenerate,
  onClose,
  onConfirmConsent,
  onContinueWithoutPreparation,
  onCancelPreparation,
  onRetryPreparation,
  onGenerateCoaching
}: CoachModalProps) {
  const busy = status === "loading" || status === "generating";

  return (
    <ModalShell opened={opened} sectionLabel="AI 코치" title="이번 달 가계부 코칭" onClose={onClose}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          설정과 계산으로 검토 대상을 정하고, 기기 안의 AI가 보조 설명을 다듬습니다.
          코칭에 사용하는 지출 정보는 AI 서버로 전송하지 않습니다.
        </Text>

        {!webGpuAvailable ? (
          <Alert variant="light" color="yellow" title="이 브라우저에서는 AI 코치를 쓸 수 없어요">
            WebGPU를 지원하는 최신 브라우저(데스크톱 Chrome/Edge 등)에서 사용할 수 있어요.
            대신 간단한 요약을 보여드릴게요.
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
            {/* 동의 대기 화면 — 모달 본문에서 다운로드 가능함을 마지막으로 한 번 더 안내. */}
            {preferencesReady && awaitingConsent && preparationState === "idle" ? (
              <Alert variant="light" color="brand" title={`${modelName} 시작`}>
                <Stack gap="sm">
                  <Text size="sm">
                    지출 요약과 절감 제안에 사용할 로컬 AI를 시작할까요?
                    저장된 파일은 재사용하고, 필요한 파일이 없으면 다운로드합니다.
                  </Text>

                  <Text size="sm" fw={500}>
                    코칭에 사용하는 지출 정보는 AI 서버로 전송하지 않습니다.
                  </Text>

                  <Stack gap="xs">
                    <Text size="sm">
                      • <strong>모델:</strong> {modelName}
                    </Text>
                    <Text size="sm">
                      • <strong>다운로드·저장 공간:</strong> 약 {approxMb}MB 예상
                    </Text>
                    <Text size="sm">
                      • <strong>GPU 메모리:</strong> 모델 설정 기준 약 {vramMb}MB
                    </Text>
                    <Text size="sm">
                      • <strong>기타 자원:</strong> 브라우저 메모리를 추가로 사용합니다. 기기에 따라 사용량이 달라요.
                    </Text>
                    <Text size="sm">
                      • <strong>저장 위치:</strong> 브라우저 내부 저장소
                    </Text>
                    <Text size="sm">
                      • <strong>네트워크:</strong> Wi-Fi 사용 권장
                    </Text>
                  </Stack>

                  <Text size="xs" c="dimmed">
                    이 창을 닫고 다른 작업을 할 수 있어요. 탭을 닫으면 준비가 중단될 수 있어요.
                  </Text>

                  <Text size="xs" c="dimmed">
                    브라우저 캐시가 정리되면 재다운로드가 필요할 수 있습니다.
                  </Text>
                </Stack>
              </Alert>
            ) : null}

            {/* 일반 안내 (준비 완료 / 데이터만 있는 경우) */}
            {preferencesReady && preparationState === "ready" && status !== "generating" && !coaching ? (
              <Alert variant="light" color="teal" title="AI 코치 준비 완료">
                <Stack gap="xs">
                  <Text size="sm">
                    로컬 AI가 준비되었습니다. 아래 버튼으로 이번 달 코칭을 받아보세요.
                  </Text>
                  <Text size="xs" c="dimmed">
                    '절감 제안 제외'한 항목은 절감·변경 권유에서 빠지고, 납부 일정과 요약에는 계속 포함돼요.
                  </Text>
                </Stack>
              </Alert>
            ) : null}

            {preparationState === "preparing" ? (
              <Stack gap={6} role="status" aria-live="polite">
                <Text size="sm">설치 중입니다. Wi-Fi 사용 권장</Text>
                <Progress value={Math.round(loadProgress * 100)} color="teal" radius="xl" striped animated />
                <Text size="xs" c="dimmed">
                  {loadText || `${Math.round(loadProgress * 100)}%`}
                </Text>
                <Text size="xs" c="dimmed">
                  이 창을 닫고 다른 작업을 할 수 있어요. 탭을 닫으면 준비가 중단될 수 있어요.
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

            {status === "error" || preparationState === "error" ? (
              <Alert variant="light" color="rose" title="코칭을 불러오지 못했어요">
                {errorMessage || "잠시 후 다시 시도해 주세요."}
                {fallbackHeadline ? (
                  <Text size="sm" mt="xs" fw={600}>
                    {fallbackHeadline}
                  </Text>
                ) : null}
              </Alert>
            ) : null}

            <Group justify="space-between" gap="sm">
              {/* 좌측: 보조 액션 (취소 / 다른 작업 계속 / 다시 시도) */}
              <Group gap="sm">
                {preparationState === "preparing" && onCancelPreparation ? (
                  <Button variant="default" radius="xl" onClick={onCancelPreparation}>
                    준비 취소
                  </Button>
                ) : null}
                {preparationState === "ready" && status !== "generating" && !coaching ? (
                  <Button variant="default" radius="xl" onClick={onClose}>
                    닫기
                  </Button>
                ) : null}
                {(preparationState === "cancelled" || preparationState === "error") && onRetryPreparation ? (
                  <Button variant="default" radius="xl" onClick={onRetryPreparation}>
                    다시 시도
                  </Button>
                ) : null}
              </Group>

              {/* 우측: 주요 액션 */}
              <Group gap="sm">
                {preparationState === "preparing" ? (
                  <Button variant="default" radius="xl" onClick={onContinueWithoutPreparation}>
                    다른 작업 계속하기
                  </Button>
                ) : preferencesReady && awaitingConsent && preparationState === "idle" ? (
                  <>
                    <Button variant="default" radius="xl" onClick={onContinueWithoutPreparation}>
                      다른 작업 계속하기
                    </Button>
                    <Button color="teal" radius="xl" onClick={onConfirmConsent || onStart}>
                      동의하고 AI 준비
                    </Button>
                  </>
                ) : preferencesReady && preparationState === "ready" && status !== "generating" && !coaching && onGenerateCoaching ? (
                  <Button color="teal" radius="xl" onClick={onGenerateCoaching}>
                    코칭 보기
                  </Button>
                ) : preferencesReady && status === "ready" && coaching ? (
                  <Button variant="default" radius="xl" onClick={onRegenerate} disabled={busy}>
                    다시 코칭받기
                  </Button>
                ) : null}
              </Group>
            </Group>
          </>
        )}
      </Stack>
    </ModalShell>
  );
}
