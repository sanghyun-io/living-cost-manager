import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Divider,
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
    onCheckServer,
    onSyncNow,
    onLoadSnapshot,
    onStayLocal,
    onOpenAuth,
    onExportBackup,
    onOpenDeleteAccount
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
          <Text size="xs" c="dimmed">{serverSession?.workspace ? serverSession.workspace.name : "가계부 선택 전"}</Text>
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
            <Text size="xs" c="dimmed">현재 가계부</Text>
            <Text fw={700}>{serverSession.workspace?.name ?? "선택 안 됨"}</Text>
            <Text size="xs" c="dimmed">{currentWorkspaceRole ? workspaceRoleLabels[currentWorkspaceRole] : "초대 수락 후 선택"}</Text>
            <Text size="xs" c="dimmed">가계부 변경은 화면 상단의 현재 가계부 선택을 사용하세요.</Text>
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

          <Divider mt="sm" mb="xs" />
          <label>
            <input type="checkbox" checked={sync.autoSyncEnabled}
              disabled={!sync.canEnableAutoSync && !sync.autoSyncEnabled}
              onChange={(event) => sync.onAutoSyncChange(event.currentTarget.checked)} />
            변경사항 자동 업로드 (이 화면을 열어 둔 동안)
          </label>
          <Text size="xs" c="dimmed">먼저 직접 동기화한 뒤 켤 수 있습니다. 충돌 시 중단하며 서버 변경을 자동으로 덮어쓰지 않습니다.</Text>
          <Group justify="space-between">
            <div>
              <Text size="xs" fw={700} c="rose">계정 삭제</Text>
              <Text size="xs" c="dimmed">
                계정과 서버 데이터가 영구 삭제되며 되돌릴 수 없습니다.
              </Text>
            </div>
            <Button
              variant="light"
              color="rose"
              size="xs"
              onClick={onOpenDeleteAccount}
              disabled={isServerBusy}
            >
              계정 삭제…
            </Button>
          </Group>
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
          선택한 가계부가 없습니다. 가계부 목록을 확인한 뒤 첫 가계부를 만들거나, 초대를 수락하고 화면 상단에서 가계부를 선택하세요. 무료판의 소유 가계부는 1개이며 기존 가계부와 공유 권한은 유지됩니다.
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
