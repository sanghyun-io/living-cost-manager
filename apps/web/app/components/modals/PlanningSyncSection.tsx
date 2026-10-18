import { Alert, Badge, Button, Card, Group, Text } from "@mantine/core";
import { formatSaveTime } from "../../lib/formatting";
import type { PlanningProps } from "../../lib/pageTypes";

const supportLabels: Record<PlanningProps["serverSupport"], string | null> = {
  unknown: null,
  available: "확인됨",
  missing: "서버 기능 미사용",
  forbidden: "권한 없음",
  unavailable: "서버 저장소 이상"
};

/** 데이터 관리 안의 "생활 계획" 절. 상태는 두 줄로 압축하고, 원시 서버 오류/
 * SDK 진단은 보여주지 않으며, 자동 덮어쓰기 경로가 전혀 없다. */
export function PlanningSyncSection({
  hasWorkspace, isViewer, canUpload, saveError, isBusy, serverSupport, serverConfirmed,
  planningActive, serverDirty, conflict, lastPlanningSyncedAt, statusMessage,
  localSummary, remoteStaged, onCheck, onUpload, onUploadOverwrite, onAdoptRemote, onDiscardRemote, onRetrySave
}: PlanningProps) {
  if (!hasWorkspace) {
    return (
      <Card withBorder padding="md" radius="sm" component="section" aria-label="생활 계획">
        <Text className="section-label" size="xs">생활 계획 · 주간 예산·급여일·준비금</Text>
        <Text size="sm" mt="xs">
          {planningActive
            ? "이 기기에는 계획 기록이 있습니다. 로그인하면 서버 기록과 확인 후 저장할 수 있습니다."
            : "계획 기록은 아직 없습니다. 첫 화면의 '주간 생활비'에서 예산을 설정하면 이 기기에 저장됩니다."}
        </Text>
        {saveError ? (
          <Alert variant="light" color="rose" mt="sm">
            <Text size="sm">{saveError}</Text>
            <Button size="xs" variant="default" mt="xs" onClick={onRetrySave}>기기 저장 재시도</Button>
          </Alert>
        ) : null}
      </Card>
    );
  }

  const deviceLine = saveError ? "기기 저장 실패 — 재시도 필요"
    : !planningActive ? "계획 기록 없음(저장 대기 아님)"
      : "기기에 저장됨";
  const serverLabel = conflict ? "충돌 · 확인 필요" : supportLabels[serverSupport];

  return (
    <Card withBorder padding="md" radius="sm" component="section" aria-label="생활 계획">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text className="section-label" size="xs">생활 계획 · 주간 예산·급여일·준비금</Text>
          <Text size="sm" mt="xs">{deviceLine}</Text>
          <Text size="xs" c="dimmed">
            서버: {serverLabel ?? (serverSupport === "missing"
              ? "이 서버에서는 계획 저장을 제공하지 않습니다(기기 기록 유지)."
              : serverConfirmed
                ? serverDirty ? "미반영 변경 있음(수동 저장)" : "마지막 확인 기준 일치"
                : "확인 전(자동 덮어쓰지 않음)")}
            {lastPlanningSyncedAt ? ` · 마지막 저장 ${formatSaveTime(lastPlanningSyncedAt)}` : ""}
          </Text>
        </div>
        <Badge color={conflict || saveError ? "rose" : serverDirty ? "yellow" : "gray"}>
          {saveError ? "저장 실패" : serverSupport === "missing" ? "미사용" : conflict ? "확인 필요" : serverDirty ? "미반영" : "대조 가능"}
        </Badge>
      </Group>

      {saveError ? (
        <Group gap="xs" mt="sm">
          <Button size="xs" variant="default" onClick={onRetrySave}>기기 저장 재시도</Button>
          <Text size="xs" c="dimmed">저장 실패 동안은 전환·교체가 막힙니다.</Text>
        </Group>
      ) : null}

      {!isViewer ? (
        <Group gap="xs" mt="sm">
          <Button size="xs" variant="subtle" disabled={isBusy} onClick={onCheck}>서버 기록 확인</Button>
          {serverSupport !== "missing" && canUpload ? (
            <Button size="xs" variant="default" disabled={isBusy || saveError !== ""} onClick={onUpload}>계획 서버 저장</Button>
          ) : null}
        </Group>
      ) : (
        <Text size="xs" c="dimmed" mt="sm">보기 전용 권한입니다. 서버 기록 확인만 가능합니다.</Text>
      )}

      {remoteStaged ? (
        <Alert variant="light" color="yellow" mt="sm" title="서버 기록이 다릅니다(자동 적용 없음)">
          <Text size="sm">
            이 기기: 주 {localSummary.weekCount}개 · 준비 {localSummary.reserveCount}개 · 급여일 {localSummary.paydayDay ?? "미설정"}
          </Text>
          <Text size="sm">
            서버({formatSaveTime(remoteStaged.checkedAt)} 확인): 주 {remoteStaged.weekCount}개 · 준비 {remoteStaged.reserveCount}개 · 급여일 {remoteStaged.paydayDay ?? "미설정"}
          </Text>
          {!isViewer ? (
            <Group gap="xs" mt="xs">
              <Button size="xs" variant="default" onClick={onAdoptRemote}>서버 기록 적용</Button>
              <Button size="xs" variant="subtle" color="rose" onClick={onUploadOverwrite}>내 기록으로 서버 저장(교체)</Button>
            </Group>
          ) : null}
          <Button size="xs" variant="subtle" mt="xs" onClick={onDiscardRemote}>비교 닫기</Button>
        </Alert>
      ) : null}

      {statusMessage ? (
        <Alert variant="light" color="teal" mt="sm">
          <Text size="sm">{statusMessage}</Text>
        </Alert>
      ) : null}

      <Text size="xs" c="dimmed" mt="sm">
        '서버에 저장'(가계부)을 누르면 가계부 업로드가 확인된 뒤 계획이 순서대로 반영됩니다. 계획만 변경된 경우는 가계부를 다시 올리지 않습니다.
        주간 예산·준비금은 공유 멤버에게 표시되는 공통 계획이며, 개인 설정은 포함되지 않습니다.
      </Text>
    </Card>
  );
}
