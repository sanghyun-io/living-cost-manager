import { useEffect, useState } from "react";
import { Button, Text } from "@mantine/core";
import { getPushConfig, isPushSupported, subscribeToPush, unsubscribeFromPush } from "../lib/push";

interface PushToggleProps {
  baseUrl: string;
  token: string;
}

export function PushToggle({ baseUrl, token }: PushToggleProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    // 푸시 지원 + 서버 활성 둘 다일 때만 노출.
    if (!isPushSupported()) {
      setAvailable(false);
      return;
    }
    getPushConfig(baseUrl)
      .then((config) => {
        if (!cancelled) {
          setAvailable(config.enabled);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  if (available !== true) {
    return null;
  }

  async function handleEnable() {
    setBusy(true);
    setStatus("");
    const result = await subscribeToPush(baseUrl, token);
    setBusy(false);
    if (result.ok) {
      setStatus("알림이 켜졌어요. 납부 예정일에 알려드릴게요.");
      return;
    }
    const messages: Record<string, string> = {
      unsupported: "이 브라우저는 알림을 지원하지 않아요.",
      denied: "알림 권한이 거부됐어요. 브라우저 설정에서 허용해 주세요.",
      "no-config": "지금은 알림을 사용할 수 없어요.",
      error: "알림 설정에 실패했어요. 잠시 후 다시 시도해 주세요."
    };
    setStatus(messages[result.reason] ?? messages.error);
  }

  async function handleDisable() {
    setBusy(true);
    await unsubscribeFromPush(baseUrl, token);
    setBusy(false);
    setStatus("알림을 껐어요.");
  }

  return (
    <div className="insights-block">
      <Text className="section-label">알림</Text>
      <Text size="sm" c="dimmed" mb="sm">
        납부 예정일이 다가오면 브라우저 알림으로 알려드려요.
      </Text>
      <Button variant="light" size="sm" loading={busy} onClick={handleEnable} mr="xs">
        알림 켜기
      </Button>
      <Button variant="subtle" size="sm" color="gray" disabled={busy} onClick={handleDisable}>
        끄기
      </Button>
      {status ? (
        <Text size="xs" c="dimmed" mt="xs">{status}</Text>
      ) : null}
    </div>
  );
}
