import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Group,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text
} from "@mantine/core";
import { formatSaveTime } from "../../lib/formatting";
import { workspaceRoleLabels } from "../../lib/sharing";
import type { SharingProps, SyncProps } from "../../lib/pageTypes";
import { BudgetSummaryCard } from "../BudgetSummaryCard";
import { SharingPanel } from "./SharingPanel";

interface ServerSyncPanelProps {
  sync: SyncProps;
  sharing: SharingProps;
}

const toneColor: Record<string, string> = {
  neutral: "gray",
  success: "teal",
  warning: "yellow",
  danger: "rose"
};

const accountSettingsPanelId = "server-sync-account-settings-panel";

export function ServerSyncPanel({ sync, sharing }: ServerSyncPanelProps) {
  const {
    serverSession,
    syncStateView,
    displayedSyncState,
    lastServerSyncedAt,
    localSnapshotSummary,
    serverSnapshotSummary,
    currentWorkspaceRole,
    canUploadServerSnapshot,
    isServerBusy,
    serverStatus,
    serverErrorKind,
    changeCurrentPassword,
    changeNewPassword,
    showUploadButton,
    showLoadButton,
    onServerLogout,
    onResendVerification,
    onChangePassword,
    onChangeCurrentPassword,
    onChangeNewPassword,
    onCheckServer,
    onSyncNow,
    onLoadSnapshot,
    onStayLocal,
    onOpenAuth,
    onOpenDeleteAccount
  } = sync;

  const [pwOpen, setPwOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const showComparison = displayedSyncState === "needs-decision" || displayedSyncState === "failed";

  return (
    <Card withBorder padding="md" radius="sm" component="section" aria-label="계정·저장">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text className="section-label" size="xs">계정·저장</Text>
          {serverSession ? (
            <>
              <Text fw={700}>{serverSession.user.name}</Text>
              <Text size="xs" c="dimmed">{serverSession.user.email} · {serverSession.workspace?.name ?? "가계부 없음"} · {currentWorkspaceRole ? workspaceRoleLabels[currentWorkspaceRole] : "-"}</Text>
              <Text size="xs" c="dimmed">마지막 동기화: {lastServerSyncedAt ? formatSaveTime(lastServerSyncedAt) : "없음"}</Text>
            </>
          ) : (
            <>
              <Text fw={700}>로컬 모드</Text>
              <Text size="xs" c="dimmed">이 기기에만 저장됩니다. 브라우저 데이터 삭제·기기 변경에 대비해 백업하세요.</Text>
            </>
          )}
        </div>
        <Group gap="xs" align="center">
          <Badge color={toneColor[syncStateView.tone] ?? "gray"}>{syncStateView.label}</Badge>
          {serverSession && sync.autoSyncEnabled ? (
            <Text size="xs" data-testid="auto-upload-indicator">자동 업로드 켜짐</Text>
          ) : null}
        </Group>
      </Group>

      {!serverSession ? (
        <Alert variant="light" color="teal" mt="sm">
          <Text size="sm">다른 기기에서도 사용하려면 로그인하세요.</Text>
          <Button size="xs" mt="xs" onClick={onOpenAuth}>로그인</Button>
        </Alert>
      ) : null}

      {serverSession && serverSession.user.emailVerified === false ? (
        <Alert variant="light" color="yellow" mt="sm">
          <Group justify="space-between">
            <Text size="sm">이메일 미인증</Text>
            <Button variant="subtle" size="xs" disabled={isServerBusy} onClick={onResendVerification}>인증 메일 재발송</Button>
          </Group>
        </Alert>
      ) : null}

      {showComparison ? (
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm" aria-label="동기화 데이터 비교">
          <BudgetSummaryCard title="이 브라우저" summary={localSnapshotSummary} />
          {serverSnapshotSummary ? (
            <BudgetSummaryCard title="서버 데이터" summary={serverSnapshotSummary} />
          ) : (
            <Card withBorder padding="sm" radius="sm">
              <Text size="sm" c="dimmed">서버 데이터</Text>
              <Text fw={700}>확인 전</Text>
              <Text size="xs" c="dimmed">상태 확인을 누르면 비교됩니다.</Text>
            </Card>
          )}
        </SimpleGrid>
      ) : null}

      {serverStatus ? (
        <Alert variant="light" color={serverErrorKind ? "rose" : "teal"} p="xs" mt="sm">
          {serverStatus.startsWith("서버 데이터를 불러왔습니다. 이전 데이터 복구 백업:")
            ? "서버 데이터를 불러왔어요. 이전 내용은 이 기기에 복구용으로 보관했습니다."
            : serverStatus}
        </Alert>
      ) : null}

      {serverSession?.workspace ? (
        <Group gap="xs" mt="sm" align="center">
          <Button variant="subtle" size="xs" disabled={isServerBusy} onClick={onCheckServer}>저장 상태 확인</Button>
          <Button variant="default" size="xs" disabled={isServerBusy || !canUploadServerSnapshot} onClick={onSyncNow} aria-label={showUploadButton ? "이 기기 데이터 저장" : "서버에 저장"}>
            {showUploadButton ? "이 기기 데이터 저장" : "서버에 저장"}
          </Button>
          {showLoadButton ? (
            <Button variant="default" size="xs" disabled={isServerBusy} onClick={onLoadSnapshot}>서버에서 불러오기</Button>
          ) : null}
          <Button variant="subtle" size="xs" disabled={isServerBusy} onClick={onStayLocal}>이 기기에서만 사용</Button>
        </Group>
      ) : null}

      {serverSession ? (
        <>
          <Button
            variant="subtle"
            size="xs"
            mt="sm"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
            aria-controls={accountSettingsPanelId}
          >
            계정 설정
          </Button>
          <Collapse in={settingsOpen}>
            <Stack gap="xs" mt="xs" id={accountSettingsPanelId}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.875rem" }}>
                <input type="checkbox" checked={sync.autoSyncEnabled}
                  disabled={!sync.canEnableAutoSync && !sync.autoSyncEnabled}
                  onChange={(event) => sync.onAutoSyncChange(event.currentTarget.checked)} />
                변경사항 자동 업로드
              </label>
              <Text size="xs" c="dimmed">이 화면을 열어 둔 동안만 동작합니다. 직접 동기화 후 켤 수 있으며 충돌 시 중단됩니다.</Text>

              <Button variant="subtle" size="xs" onClick={() => setPwOpen((o) => !o)}>비밀번호 변경</Button>
              <Collapse in={pwOpen}>
                <form onSubmit={(event) => { event.preventDefault(); onChangePassword(); }}>
                  <PasswordInput label="현재 비밀번호" value={changeCurrentPassword} onChange={(event) => onChangeCurrentPassword(event.currentTarget.value)} mb="xs" size="xs" />
                  <PasswordInput label="새 비밀번호" value={changeNewPassword} onChange={(event) => onChangeNewPassword(event.currentTarget.value)} mb="sm" size="xs" />
                  <Button type="submit" variant="default" size="xs" disabled={isServerBusy || changeCurrentPassword.length < 8 || changeNewPassword.length < 8}>변경</Button>
                </form>
              </Collapse>

              <Group justify="space-between" mt="xs">
                <Text size="xs" c="dimmed">계정과 서버 데이터가 삭제되며 되돌릴 수 없습니다.</Text>
                <Button variant="light" color="rose" size="xs" onClick={onOpenDeleteAccount} disabled={isServerBusy}>계정 삭제…</Button>
              </Group>

              <Button variant="subtle" size="xs" onClick={onServerLogout}>로그아웃</Button>
            </Stack>
          </Collapse>
        </>
      ) : null}

      {serverSession ? (
        <SharingPanel {...sharing} />
      ) : null}
    </Card>
  );
}
