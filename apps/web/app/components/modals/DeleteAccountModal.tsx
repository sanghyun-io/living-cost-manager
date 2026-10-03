import { useState } from "react";
import { Alert, Button, Divider, Group, List, PasswordInput, Stack, Text } from "@mantine/core";
import { ModalShell } from "./ModalShell";

interface DeleteAccountModalProps {
  opened: boolean;
  /** The signed-in account's email, shown in both confirmation steps. */
  email: string;
  /** True when the user participates in workspaces they do not own. */
  hasSharedWorkspaces: boolean;
  isBusy: boolean;
  statusMessage: string;
  statusError: boolean;
  /** Runs DELETE /account. Resolves "deleted" on success (204). */
  onConfirm: (password: string) => Promise<"deleted" | "error">;
  onClose: () => void;
}

/**
 * Two-step, password-reconfirmed account deletion (GDPR erasure entry point
 * in Settings > Account). Step 1 collects the password after the irreversible
 * warning; step 2 is the red "영구 삭제" button on its own so a single stray
 * click can never delete an account.
 */
export function DeleteAccountModal({
  opened,
  email,
  hasSharedWorkspaces,
  isBusy,
  statusMessage,
  statusError,
  onConfirm,
  onClose
}: DeleteAccountModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [password, setPassword] = useState("");

  async function handleDelete() {
    const result = await onConfirm(password);
    if (result === "deleted") {
      setStep(1);
      setPassword("");
    }
  }

  function handleClose() {
    setStep(1);
    setPassword("");
    onClose();
  }

  return (
    <ModalShell opened={opened} sectionLabel="계정" title="계정 삭제" onClose={handleClose}>
      {step === 1 ? (
        <Stack gap="sm">
          <Alert variant="light" color="rose" title="삭제한 계정은 되돌릴 수 없습니다.">
            <Text size="sm">
              서버의 계정과 소유 워크스페이스(고정비·카테고리·카드·백업 포함)가 즉시 영구
              삭제됩니다. 다른 기기관련 데이터는 지워지지 않으므로, 필요하면 데이터 관리의
              &quot;전체 Export&quot;로 백업하세요.
            </Text>
          </Alert>
          <List size="sm" withPadding>
            <List.Item>
              소유한 워크스페이스에 <Text span fw={700}>다른 멤버가 있으면</Text>{" "}
              삭제가 차단됩니다. 먼저 소유권을 이전하세요.
            </List.Item>
            {hasSharedWorkspaces ? (
              <List.Item>
                남의 워크스페이스에 멤버로 참여 중입니다. 삭제 시 그 워크스페이스에서는
                멤버십만 제거되고 상대 데이터는 그대로 남습니다.
              </List.Item>
            ) : null}
            <List.Item>이 브라우저의 저장 데이터(사용자 항목·예산 데이터·서버 세션)도 함께 삭제됩니다.</List.Item>
          </List>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (password.length >= 8) {
                setStep(2);
              }
            }}
          >
            <PasswordInput
              label="비밀번호 재확인"
              description="보안을 위해 삭제 전에 비밀번호를 다시 입력합니다."
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              error={password.length > 0 && password.length < 8 ? "비밀번호는 8자 이상이어야 합니다." : null}
              mb="sm"
            />
            <Button type="submit" variant="default" disabled={password.length < 8}>
              계속 (단계 1/2)
            </Button>
          </form>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Alert variant="light" color="rose" title="최종 확인">
            <Text size="sm">
              아래 버튼을 누르면 <Text span fw={700}>{email}</Text> 계정과
              서버 데이터가 <Text span fw={700}>즉시·영구적으로</Text> 삭제되며
              복구할 수 없습니다.
            </Text>
          </Alert>
          <Group gap="xs">
            <Button variant="subtle" onClick={() => setStep(1)} disabled={isBusy}>
              취소하고 돌아가기
            </Button>
            <Button color="rose" loading={isBusy} onClick={() => void handleDelete()}>
              영구 삭제 (단계 2/2)
            </Button>
          </Group>
          <Divider />
          <Text size="xs" c="dimmed">
            소유권을 이전할 워크스페이스가 있다면 삭제 대신 “서버 로그아웃”으로 브라우저만
            정리할 수 있습니다.
          </Text>
        </Stack>
      )}
      {statusMessage ? (
        <Alert variant="light" color={statusError ? "red" : "teal"} p="xs">
          {statusMessage}
        </Alert>
      ) : null}
    </ModalShell>
  );
}
