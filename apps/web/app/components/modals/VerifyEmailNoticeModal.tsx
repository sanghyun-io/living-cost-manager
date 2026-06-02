import { Alert, Button, Stack, Text } from "@mantine/core";
import { ModalShell } from "./ModalShell";

interface VerifyEmailNoticeModalProps {
  opened: boolean;
  email: string;
  isServerBusy: boolean;
  serverStatus: string;
  serverErrorKind: "auth" | "request" | null;
  onResend: () => void;
  onContinue: () => void;
  onClose: () => void;
}

// Shown right after a successful signup. Cloud sync and sharing are gated behind
// email verification, so we surface a "check your email" step instead of dropping
// the user straight into the data modal.
export function VerifyEmailNoticeModal({
  opened,
  email,
  isServerBusy,
  serverStatus,
  serverErrorKind,
  onResend,
  onContinue,
  onClose
}: VerifyEmailNoticeModalProps) {
  return (
    <ModalShell opened={opened} sectionLabel="클라우드" title="이메일을 확인하세요" onClose={onClose}>
      <Stack gap="sm">
        <Text size="sm">
          <Text span fw={600}>
            {email}
          </Text>
          로 인증 메일을 보냈습니다. 메일의 링크를 눌러 이메일 인증을 완료하세요.
        </Text>
        <Alert variant="light" color="yellow" p="xs">
          인증을 마치기 전까지는 클라우드 저장(동기화)과 멤버 초대가 제한됩니다. 메일이 보이지 않으면 스팸함도 확인해 주세요.
        </Alert>
        <Button variant="light" onClick={onResend} loading={isServerBusy} fullWidth>
          인증 메일 다시 보내기
        </Button>
        <Button variant="subtle" onClick={onContinue} fullWidth>
          나중에 인증하고 계속하기
        </Button>
        {serverStatus ? (
          <Alert variant="light" color={serverErrorKind ? "rose" : "teal"} p="xs">
            {serverStatus}
          </Alert>
        ) : null}
      </Stack>
    </ModalShell>
  );
}
