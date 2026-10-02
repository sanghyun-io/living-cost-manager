import { useState } from "react";
import { Alert, Anchor, Button, Group, PasswordInput, SegmentedControl, Text, TextInput } from "@mantine/core";
import type { ServerSession } from "../../lib/serverApi";
import {
  authEmailMessage,
  authPasswordMessage,
  CLEAN_AUTH_TOUCHED,
  type AuthTouched
} from "../../lib/validation";
import { ModalShell } from "./ModalShell";

/** Values the parent needs to run the actual auth request. */
export interface AuthFormValues {
  email: string;
  password: string;
  name: string;
  mode: "login" | "register";
}

interface AuthModalProps {
  opened: boolean;
  hasServerApi: boolean;
  /**
   * Set exactly once by the page's boot effect when a stored server session
   * was restored. The modal seeds the email/name drafts from it — mirroring
   * the old boot effect's setServerEmail/setServerName (fresh logins keep the
   * typed values, like before).
   */
  initialSession: ServerSession | null;
  isServerBusy: boolean;
  serverStatus: string;
  serverErrorKind: "auth" | "request" | null;
  /**
   * Runs the server call. Resolves true on success — the modal then clears the
   * password draft, matching the old page-level behavior.
   */
  onSubmit: (values: AuthFormValues) => Promise<boolean>;
  /** "Password forgot" link submit; receives the current email draft. */
  onForgotSubmit: (email: string) => void;
  /** Notifies the parent on view switches so it can clear the status line. */
  onViewChange: (view: "auth" | "forgot") => void;
  /**
   * Bumping this signal (after a successful reset) forces the form back to the
   * login view — the old page did setServerAuthMode("login") + setAuthView("auth").
   */
  loginRequest: number;
  onClose: () => void;
}

export function AuthModal({
  opened,
  hasServerApi,
  initialSession,
  isServerBusy,
  serverStatus,
  serverErrorKind,
  onSubmit,
  onForgotSubmit,
  onViewChange,
  loginRequest,
  onClose
}: AuthModalProps) {
  // Form drafts live here now. This wrapper stays mounted for the whole page
  // lifetime (only Mantine's content unmounts on close), so drafts persist
  // across open/close exactly like the previous page-level state.
  //
  // Boot prefill: the page gates all modals until after the boot effect has
  // set initialSession, so seeding the useState initializers reproduces the
  // old boot-time setServerEmail/setServerName exactly (and, like the
  // original, never touches these drafts afterwards).
  const [serverEmail, setServerEmail] = useState(initialSession?.user.email ?? "");
  const [serverPassword, setServerPassword] = useState("");
  const [serverName, setServerName] = useState(initialSession?.user.name ?? "");
  const [serverAuthMode, setServerAuthMode] = useState<"login" | "register">("login");
  const [authView, setAuthView] = useState<"auth" | "forgot">("auth");
  // Track which auth fields the user has left (blurred) so we only surface
  // validation errors after they finish typing a field, not while typing.
  // Name is optional (falls back to email), so it has no validation entry.
  const [authTouched, setAuthTouched] = useState<AuthTouched>(CLEAN_AUTH_TOUCHED);

  // Password-reset success reopens this modal in login mode. Adjusted during
  // render (not in an effect) so the modal never paints a frame in the stale
  // mode/view — the old page set mode+view+open in one batch, same frame.
  const [seenLoginRequest, setSeenLoginRequest] = useState(0);
  if (loginRequest !== seenLoginRequest) {
    setSeenLoginRequest(loginRequest);
    setServerAuthMode("login");
    setAuthView("auth");
  }

  const authEmailError = authEmailMessage(serverEmail);
  const authPasswordError = authPasswordMessage(serverPassword);
  // Name is optional at submit time (falls back to email), so it never blocks.
  const isAuthFormValid = !authEmailError && !authPasswordError;

  function markAuthFieldTouched(field: "email" | "password") {
    setAuthTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }

  function handleModeChange(mode: "login" | "register") {
    setServerAuthMode(mode);
    setAuthTouched(CLEAN_AUTH_TOUCHED);
  }

  // View switches live in the modal now; the parent is only notified so it can
  // clear the server status line (matching the old page behavior).
  function changeView(view: "auth" | "forgot") {
    setAuthView(view);
    onViewChange(view);
  }

  function handleSubmit() {
    // Guard against programmatic/Enter submits when the form is invalid, and
    // reveal any outstanding errors by marking the relevant fields touched.
    if (!isAuthFormValid) {
      setAuthTouched({ email: true, password: true });
      return;
    }
    void onSubmit({ email: serverEmail, password: serverPassword, name: serverName, mode: serverAuthMode }).then((ok) => {
      if (ok) {
        setServerPassword("");
      }
    });
  }

  const title = serverAuthMode === "register" ? "계정 가입" : "로그인";
  const statusEl = serverStatus ? (
    <Alert variant="light" color={serverErrorKind ? "rose" : "teal"} p="xs">
      {serverStatus}
    </Alert>
  ) : null;

  return (
    <ModalShell opened={opened} sectionLabel="클라우드" title={title} onClose={onClose}>
      {hasServerApi ? (
        authView === "forgot" ? (
          <>
            <Text size="sm" c="dimmed">
              가입한 이메일로 비밀번호 재설정 링크를 보내드립니다.
            </Text>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onForgotSubmit(serverEmail);
              }}
            >
              <TextInput
                label="이메일"
                type="email"
                value={serverEmail}
                onChange={(event) => setServerEmail(event.currentTarget.value)}
                mb="md"
              />
              <Button type="submit" loading={isServerBusy} fullWidth>
                재설정 링크 보내기
              </Button>
            </form>
            <Anchor component="button" type="button" size="sm" onClick={() => changeView("auth")}>
              로그인으로 돌아가기
            </Anchor>
            {statusEl}
          </>
        ) : (
          <>
            <Text size="sm" c="dimmed">
              클라우드에 저장하면 다른 기기에서도 데이터를 이어서 사용할 수 있습니다. 브라우저 로컬 저장은 그대로 유지됩니다.
            </Text>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleSubmit();
              }}
            >
              <SegmentedControl
                fullWidth
                mb="sm"
                value={serverAuthMode}
                onChange={(value) => handleModeChange(value as "login" | "register")}
                data={[
                  { value: "login", label: "로그인" },
                  { value: "register", label: "가입" }
                ]}
              />
              <TextInput
                label="이메일"
                type="email"
                value={serverEmail}
                onChange={(event) => setServerEmail(event.currentTarget.value)}
                onBlur={() => markAuthFieldTouched("email")}
                error={authTouched.email ? authEmailError : null}
                mb="sm"
              />
              {serverAuthMode === "register" ? (
                <TextInput
                  label="이름"
                  value={serverName}
                  onChange={(event) => setServerName(event.currentTarget.value)}
                  mb="sm"
                />
              ) : null}
              <PasswordInput
                label="비밀번호"
                value={serverPassword}
                onChange={(event) => setServerPassword(event.currentTarget.value)}
                onBlur={() => markAuthFieldTouched("password")}
                error={authTouched.password ? authPasswordError : null}
                description={authTouched.password && authPasswordError ? undefined : "비밀번호는 8자 이상이어야 합니다."}
                mb="md"
              />
              <Button type="submit" loading={isServerBusy} disabled={!isAuthFormValid} fullWidth>
                {serverAuthMode === "register" ? "가입하고 클라우드에 저장" : "로그인"}
              </Button>
            </form>
            <Group gap={4}>
              {serverAuthMode === "login" ? (
                <>
                  <Text size="sm" c="dimmed">계정이 없으신가요?</Text>
                  <Anchor component="button" type="button" size="sm" onClick={() => handleModeChange("register")}>
                    가입하기
                  </Anchor>
                  <Anchor component="button" type="button" size="sm" onClick={() => changeView("forgot")}>
                    비밀번호를 잊으셨나요?
                  </Anchor>
                </>
              ) : (
                <>
                  <Text size="sm" c="dimmed">이미 계정이 있으신가요?</Text>
                  <Anchor component="button" type="button" size="sm" onClick={() => handleModeChange("login")}>
                    로그인하기
                  </Anchor>
                </>
              )}
            </Group>
            {statusEl}
          </>
        )
      ) : (
        <Alert variant="light" color="yellow" title="서버 API URL이 없어 클라우드 저장을 사용할 수 없습니다.">
          이 브라우저에만 저장됩니다. 데이터 관리에서 전체 백업을 보관하세요.
        </Alert>
      )}
    </ModalShell>
  );
}
