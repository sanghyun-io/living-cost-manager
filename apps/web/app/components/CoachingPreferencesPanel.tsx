"use client";
import { Button, Checkbox, Group, Select, Text, Badge } from "@mantine/core";
import type { FixedCost } from "../lib/budget";
import type { CoachingPreferences, ProtectedCoachingItem } from "@living-cost-manager/shared";

export function CoachingPreferencesPanel({
  items,
  prefs,
  activeIds,
  toggle,
  setReason,
  status,
  busy,
  dirty,
  save,
  load,
  canCloudAccess = true,
  ready = true
}: {
  items: FixedCost[];
  prefs: CoachingPreferences;
  activeIds: ReadonlySet<string>;
  toggle: (id: string, reason?: ProtectedCoachingItem["reason"]) => void;
  setReason: (id: string, reason: ProtectedCoachingItem["reason"] | undefined) => void;
  status: string;
  busy: boolean;
  dirty: boolean;
  save: () => void;
  load: (replace?: boolean) => void;
  canCloudAccess?: boolean;
  ready?: boolean;
}) {
  const choices = [
    { value: "essential", label: "필수 지출" },
    { value: "contract", label: "계약·약정" },
    { value: "personal", label: "개인적 선택" }
  ];

  const protectedCount = activeIds.size;
  const hasItems = items.length > 0;

  return (
    <section aria-labelledby="coach-prefs-title" className="insights-block">
      {!ready && status ? <Text role="alert" size="sm">{status}</Text> : null}
      <details className="insights-details">
        <summary>
          <Group justify="space-between" wrap="nowrap">
            <Text id="coach-prefs-title" fw={600}>내 코칭 설정</Text>
            {protectedCount > 0 && (
              <Badge size="sm" variant="light">
                유지 {protectedCount}건
              </Badge>
            )}
          </Group>
        </summary>

        <Text size="sm" c="dimmed" mt="sm">
          유지할 항목은 절감·변경 권유에서 제외합니다. 이유는 선택 사항이며 예산 데이터와 별도로 저장됩니다.
        </Text>

        {hasItems ? (
          <ul className="insights-list" style={{ marginTop: "0.5rem" }}>
            {items.map(item => {
              const isProtected = activeIds.has(item.id);
              const currentReason = prefs.protectedItems.find(x => x.fixedCostId === item.id)?.reason;

              return (
                <li key={item.id} className="insights-row">
                  <Checkbox
                    disabled={!ready}
                    checked={isProtected}
                    onChange={() => { if (ready) toggle(item.id); }}
                    label={`${item.name} 유지`}
                    aria-label={`${item.name} 유지 설정`}
                  />
                  {isProtected && (
                    <Select
                      disabled={!ready}
                      aria-label={`${item.name} 유지 이유`}
                      placeholder="이유 선택 (선택 사항)"
                      data={choices}
                      value={currentReason ?? null}
                      onChange={(v) => {
                        if (!ready) return;
                        if (v === "essential" || v === "contract" || v === "personal") {
                          setReason(item.id, v);
                        } else if (v === null) {
                          setReason(item.id, undefined);
                        }
                      }}
                      clearable
                    />
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <Text size="sm" c="dimmed" mt="sm">
            고정비 항목이 없습니다. 항목을 추가하면 코칭 설정을 할 수 있습니다.
          </Text>
        )}

        {protectedCount > 0 && (
          <div style={{ marginTop: "0.5rem" }}>
            <Text size="sm" fw={600}>유지 중인 항목 ({protectedCount}건)</Text>
            <Group gap="xs" mt="xs">
              {items
                .filter(i => activeIds.has(i.id))
                .map(i => (
                  <Button
                    key={i.id}
                    disabled={!ready}
                    variant="subtle"
                    size="xs"
                    onClick={() => toggle(i.id)}
                    aria-label={`${i.name} 유지 해제`}
                  >
                    {i.name} · 해제
                  </Button>
                ))}
            </Group>
          </div>
        )}

        <Group mt="sm" gap="xs">
          <Button
            variant="default"
            size="sm"
            disabled={!ready || busy || !canCloudAccess}
            onClick={() => load()}
          >
            서버에서 불러오기
          </Button>
          <Button
            size="sm"
            disabled={!ready || busy || !dirty || !canCloudAccess}
            onClick={save}
          >
            서버에 저장
          </Button>
        </Group>

        {!canCloudAccess && (
          <Text size="xs" c="dimmed" mt="xs">
            로그인 후 워크스페이스에서 서버 동기화를 사용할 수 있습니다.
          </Text>
        )}

        <Text role="status" aria-live="polite" size="sm" mt="xs">
          {status || (dirty ? "기기에 저장됨 · 서버 미동기화" : "이 설정은 자동으로 서버에 동기화되지 않습니다.")}
        </Text>
      </details>
    </section>
  );
}
