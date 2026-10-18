import { Alert, Badge, Button, Card, Group, Text } from "@mantine/core";
import { formatWon, formatSaveTime } from "../../lib/formatting";
import type { PlanningProps } from "../../lib/pageTypes";

const supportLabels: Record<PlanningProps["serverSupport"], string | null> = {
  unknown: null,
  available: "확인됨",
  missing: "서버 기능 미사용",
  forbidden: "권한 없음",
  unavailable: "서버 저장소 이상"
};

function amountText(value: number | null): string {
  return value === null ? "미설정/기록없음" : formatWon(value);
}

/** 데이터 관리 안의 "생활 계획" 절. 상태는 압축 표시하고 원시 서버 진단은 보여주지
 * 않으며, 자동 덮어쓰기 경로가 전혀 없다. 발산(서버 기록 상이)은 비교를 닫아도
 * 계속 서버 반영을 막고, 교체 권한은 열린 비교의 명시 선택에서만 생긴다. */
export function PlanningSyncSection({
  hasWorkspace, isViewer, canUpload, saveError, isBusy, serverSupport, serverConfirmed,
  planningActive, serverDirty, hasRemoteDivergence, conflict, lastPlanningSyncedAt, statusMessage,
  localSummary, remoteStaged, onCheck, onUpload, onUploadOverwrite, onAdoptRemote, onCloseComparison, onRetrySave
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
            서버: {serverLabel ?? (hasRemoteDivergence
              ? "기록 상이(미해소) — 저장은 서버 적용 또는 명시 교체 후 가능"
              : serverSupport === "missing"
                ? "이 서버에서는 계획 저장을 제공하지 않습니다(기기 기록 유지)."
                : serverConfirmed
                  ? serverDirty ? "미반영 변경 있음(수동 저장)" : "마지막 확인 기준 일치"
                  : "확인 전(자동 덮어쓰지 않음)")}
            {lastPlanningSyncedAt ? ` · 마지막 저장 ${formatSaveTime(lastPlanningSyncedAt)}` : ""}
          </Text>
        </div>
        <Badge color={conflict || saveError ? "rose" : hasRemoteDivergence || serverDirty ? "yellow" : "gray"}>
          {saveError ? "저장 실패" : serverSupport === "missing" ? "미사용" : conflict ? "확인 필요" : hasRemoteDivergence ? "서버 기록 상이" : serverDirty ? "미반영" : "대조 가능"}
        </Badge>
      </Group>

      {!remoteStaged && hasRemoteDivergence ? (
        <Alert variant="light" color="yellow" mt="sm" title="서버 기록과 다릅니다(비교는 닫힘)">
          <Text size="sm">발산이 남아 있어 일반 서버 저장은 막혀 있습니다. 서버 기록을 다시 확인한 뒤 '서버 기록 적용' 또는 '열린 비교에서의 명시적 교체'만 가능합니다.</Text>
          <Button size="xs" variant="default" mt="xs" disabled={isBusy} onClick={onCheck}>서버 기록 다시 확인</Button>
        </Alert>
      ) : null}

      {saveError ? (
        <Group gap="xs" mt="sm">
          <Button size="xs" variant="default" onClick={onRetrySave}>기기 저장 재시도</Button>
          <Text size="xs" c="dimmed">저장 실패 동안은 전환·교체가 막힙니다.</Text>
        </Group>
      ) : null}

      {!isViewer ? (
        <Group gap="xs" mt="sm">
          <Button size="xs" variant="subtle" disabled={isBusy} onClick={onCheck}>서버 기록 확인</Button>
          {serverSupport !== "missing" && canUpload && !hasRemoteDivergence ? (
            <Button size="xs" variant="default" disabled={isBusy || saveError !== ""} onClick={onUpload}>계획 서버 저장</Button>
          ) : null}
        </Group>
      ) : null}

      {remoteStaged ? (
        <Alert variant="light" color="yellow" mt="sm" title="서버 기록이 다릅니다(자동 적용 없음)">
          <Text size="sm">
            이 기기: 주 {localSummary.weekCount}개 · 준비 {localSummary.reserveCount}개 · 급여일 {localSummary.paydayDay ?? "미설정"}
          </Text>
          <Text size="sm">
            서버({formatSaveTime(remoteStaged.checkedAt)} 확인): 주 {remoteStaged.weekCount}개 · 준비 {remoteStaged.reserveCount}개 · 급여일 {remoteStaged.paydayDay ?? "미설정"}
          </Text>
          {remoteStaged.rows.length > 0 ? (
            <div>
              {remoteStaged.rows.map(row => (
                <Text key={row.label} size="xs">서버 주 {row.label}: 예산 {amountText(row.budget)} · 사용 {amountText(row.spent)}</Text>
              ))}
            </div>
          ) : null}
          {remoteStaged.reserveRows.length > 0 ? (
            <div>
              {remoteStaged.reserveRows.map(row => (
                <Text key={row.label} size="xs">서버 준비 {row.label}: 모아둠 {amountText(row.saved)} / 목표 {amountText(row.target)}</Text>
              ))}
            </div>
          ) : null}
          <Group gap="xs" mt="xs">
            <Button size="xs" variant="default" onClick={onAdoptRemote}>{isViewer ? "서버 기록을 이 기기에 표시(읽기)" : "서버 기록 적용"}</Button>
            {!isViewer ? (
              <Button size="xs" variant="subtle" color="rose" onClick={onUploadOverwrite}>내 기록으로 서버 저장(교체)</Button>
            ) : null}
            <Button size="xs" variant="subtle" mt="xs" onClick={onCloseComparison}>비교 닫기</Button>
          </Group>
          <Text size="xs" c="dimmed" mt="xs">
            비교를 닫아도 서버 기록 상이가 해소되지 않으며 일반 저장은 계속 막힙니다. 교체는 이 화면이 열려 있을 때만 선택할 수 있습니다.
          </Text>
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
