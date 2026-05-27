import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Group,
  PasswordInput,
  Select,
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

export function ServerSyncPanel({ sync, sharing }: ServerSyncPanelProps) {
  const {
    serverSession,
    syncStateView,
    displayedSyncState,
    lastServerSyncedAt,
    localSnapshotSummary,
    serverSnapshotSummary,
    serverWorkspaces,
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
    onSelectWorkspace,
    onCheckServer,
    onSyncNow,
    onLoadSnapshot,
    onStayLocal,
    onOpenAuth,
    onExportBackup
  } = sync;

  const [pwOpen, setPwOpen] = useState(false);
  const showLocalWarning = displayedSyncState === "local-only" || displayedSyncState === "server-available";

  return (
    <Card withBorder padding="md" radius="sm" component="section" aria-label="서버 동기화">
      <Group justify="space-between" mb="sm">
        <div>
          <Text className="section-label" size="xs">서버 동기화</Text>
          <Text fw={700}>계정 및 공유</Text>
        </div>
        {serverSession ? (
          <Button variant="default" size="xs" onClick={onServerLogout}>
            서버 로그아웃
          </Button>
        ) : null}
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2 }} mb="sm">
        <Card withBorder padding="sm" radius="sm" bg={`var(--mantine-color-${toneColor[syncStateView.tone] ?? "gray"}-light)`}>
          <Text size="xs" c="dimmed">현재 저장 모드</Text>
          <Text fw={700}>{syncStateView.label}</Text>
          <Text size="xs" c="dimmed">{syncStateView.description}</Text>
        </Card>
        <Card withBorder padding="sm" radius="sm">
          <Text size="xs" c="dimmed">마지막 서버 동기화</Text>
          <Text fw={700}>{lastServerSyncedAt ? formatSaveTime(lastServerSyncedAt) : "아직 없음"}</Text>
          <Text size="xs" c="dimmed">{serverSession?.workspace ? serverSession.workspace.name : "서버 워크스페이스 선택 전"}</Text>
        </Card>
      </SimpleGrid>

      {showLocalWarning ? (
        <Alert variant="light" color="yellow" title="로컬 모드: 이 브라우저에만 저장됩니다." mb="sm">
          <Text size="sm" mb="xs">
            브라우저 데이터를 삭제하거나 기기를 바꾸면 복구할 수 없습니다. 로그인해서 클라우드에 저장하면 다른 기기에서도 이어서 사용할 수 있습니다.
          </Text>
          <Button variant="default" size="xs" onClick={onExportBackup}>
            전체 Export 백업
          </Button>
        </Alert>
      ) : null}

      <SimpleGrid cols={{ base: 1, sm: 2 }} mb="sm" className="sync-summary-grid" aria-label="동기화 데이터 비교">
        <BudgetSummaryCard title="이 브라우저" summary={localSnapshotSummary} />
        {serverSnapshotSummary ? (
          <BudgetSummaryCard title="서버 데이터" summary={serverSnapshotSummary} />
        ) : (
          <Card withBorder padding="sm" radius="sm">
            <Text size="sm" c="dimmed">서버 데이터</Text>
            <Text fw={700}>확인 전</Text>
            <Text size="xs" c="dimmed">서버 상태 확인을 누르면 비교 정보가 표시됩니다.</Text>
          </Card>
        )}
      </SimpleGrid>

      {serverSession ? (
        <SimpleGrid cols={{ base: 1, sm: 2 }} mb="sm">
          <div>
            <Text size="xs" c="dimmed">계정</Text>
            <Text fw={700}>{serverSession.user.name}</Text>
            <Text size="xs" c="dimmed">{serverSession.user.email}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">워크스페이스</Text>
            <Text fw={700}>{serverSession.workspace?.name ?? "선택 안 됨"}</Text>
            <Text size="xs" c="dimmed">{currentWorkspaceRole ? workspaceRoleLabels[currentWorkspaceRole] : "초대 수락 후 선택"}</Text>
            {serverWorkspaces.length > 1 ? (
              <Select
                aria-label="서버 워크스페이스 선택"
                mt="xs"
                size="xs"
                allowDeselect={false}
                value={serverSession.workspace?.id ?? null}
                data={serverWorkspaces.map((w) => ({ value: w.id, label: w.name }))}
                onChange={(value) => onSelectWorkspace(value ?? "")}
              />
            ) : null}
          </div>
        </SimpleGrid>
      ) : null}

      {serverSession && serverSession.user.emailVerified === false ? (
        <Alert variant="light" color="yellow" mb="sm">
          <Group justify="space-between">
            <Text size="sm">이메일 미인증</Text>
            <Button variant="subtle" size="xs" disabled={isServerBusy} onClick={onResendVerification}>
              인증 메일 재발송
            </Button>
          </Group>
        </Alert>
      ) : null}

      {serverSession ? (
        <>
          <Button variant="subtle" size="xs" mb="xs" onClick={() => setPwOpen((o) => !o)}>
            비밀번호 변경
          </Button>
          <Collapse in={pwOpen}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onChangePassword();
              }}
            >
              <PasswordInput
                label="현재 비밀번호"
                value={changeCurrentPassword}
                onChange={(event) => onChangeCurrentPassword(event.currentTarget.value)}
                mb="xs"
              />
              <PasswordInput
                label="새 비밀번호"
                value={changeNewPassword}
                onChange={(event) => onChangeNewPassword(event.currentTarget.value)}
                mb="sm"
              />
              <Button
                type="submit"
                variant="default"
                size="xs"
                disabled={isServerBusy || changeCurrentPassword.length < 8 || changeNewPassword.length < 8}
              >
                비밀번호 변경
              </Button>
            </form>
          </Collapse>
        </>
      ) : null}

      {!serverSession ? (
        <Alert variant="light" color="teal" mb="sm">
          <Text size="sm" mb="xs">클라우드에 저장하려면 로그인이 필요합니다. 계정이 없으면 가입한 뒤 이어서 사용할 수 있습니다.</Text>
          <Button size="xs" onClick={onOpenAuth}>
            로그인 / 가입하기
          </Button>
        </Alert>
      ) : null}

      {serverStatus ? (
        <Alert variant="light" color={serverErrorKind ? "rose" : "teal"} p="xs" mb="sm">
          {serverStatus}
        </Alert>
      ) : null}
      {serverSession && serverWorkspaces.length === 0 ? (
        <Text size="xs" c="dimmed" mb="sm">
          사용 가능한 서버 워크스페이스가 없습니다. 새 계정을 만들거나 초대를 수락한 뒤 동기화를 사용할 수 있습니다.
        </Text>
      ) : null}

      {serverSession?.workspace ? (
        <Group gap="xs" mb="sm">
          <Button variant="default" size="xs" disabled={isServerBusy} onClick={onCheckServer}>
            서버 상태 확인
          </Button>
          <Button variant="default" size="xs" disabled={isServerBusy || !canUploadServerSnapshot} onClick={onSyncNow}>
            지금 동기화
          </Button>
          {showUploadButton ? (
            <Button variant="default" size="xs" disabled={isServerBusy || !canUploadServerSnapshot} onClick={onSyncNow}>
              이 브라우저 데이터 업로드
            </Button>
          ) : null}
          {showLoadButton ? (
            <Button variant="default" size="xs" disabled={isServerBusy} onClick={onLoadSnapshot}>
              서버 데이터 불러오기
            </Button>
          ) : null}
          <Button variant="default" size="xs" disabled={isServerBusy} onClick={onStayLocal}>
            로컬 전용 유지
          </Button>
        </Group>
      ) : null}

      <SharingPanel {...sharing} />
    </Card>
  );
}
