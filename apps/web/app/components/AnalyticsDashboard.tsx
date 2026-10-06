"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text
} from "@mantine/core";
import { ANALYTICS_EVENT_LABELS, type AnalyticsEvent } from "@living-cost-manager/shared";
import { clearEvents, getEvents, localDateKey, summarizeByDay } from "../lib/analytics";

type AnalyticsRange = "7" | "30";

const RANGE_DAYS: Record<AnalyticsRange, number> = { "7": 7, "30": 30 };

interface ChartRow {
  key: string;
  label: string;
  count: number;
}

/** 기간 시작일(오늘 포함 N일 전)의 로컬 날짜 키. 정오 앵커로 DST 경계를 피한다. */
function periodDateKeys(days: number): string[] {
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setHours(12, 0, 0, 0);
    day.setDate(day.getDate() - offset);
    keys.push(localDateKey(day.getTime()));
  }
  return keys;
}

function shortDateLabel(dateKey: string): string {
  return dateKey.slice(5).replace("-", ".");
}

/**
 * Settings(DataModal) > 애널리틱스 패널.
 *
 * 데이터 소스는 온디바이스 IndexedDB(lcm-analytics) 뿐이다 — 이 화면에 있는
 * 어떤 동작도 네트워크로 이벤트を送지 않는다. 읽기는 저장된 이벤트 + 아직
 * flush 되지 않은 큐를 합치므로 방금 발생한 이벤트도 바로 보인다.
 */
export function AnalyticsDashboard() {
  const [events, setEvents] = useState<AnalyticsEvent[]>([]);
  const [range, setRange] = useState<AnalyticsRange>("7");
  const [status, setStatus] = useState("");

  async function reload() {
    setEvents(await getEvents());
    setStatus("");
  }

  // DataModal(Mantine Modal)은 닫히면 자식을 언마운트하므로, 이 효과는
  // 패널이 열릴 때마다 다시 실행되어 항상 최신 저장소를 읽는다.
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const days = RANGE_DAYS[range];

  const { chartRows, periodTotal, activeDays, typeRows, topTypeLabel, lastEventAt } = useMemo(() => {
    const daily = summarizeByDay(events);
    const byDate = new Map(daily.map((entry) => [entry.date, entry] as const));
    const keys = periodDateKeys(days);
    const windowed = keys.map((key) => byDate.get(key) ?? null);

    let total = 0;
    let active = 0;
    const typeTotals: Record<string, number> = {};
    for (const entry of windowed) {
      if (!entry) {
        continue;
      }
      total += entry.total;
      if (entry.total > 0) {
        active += 1;
      }
      for (const [type, count] of Object.entries(entry.byType)) {
        typeTotals[type] = (typeTotals[type] ?? 0) + count;
      }
    }

    // 7일: 일별 막대. 30일: 주(7일) 단위로 묶은 막대 — 30줄은 모바일에서 읽기 어렵다.
    const rows: ChartRow[] = [];
    if (days <= 7) {
      keys.forEach((key, index) => {
        rows.push({ key, label: shortDateLabel(key), count: windowed[index]?.total ?? 0 });
      });
    } else {
      for (let start = 0; start < keys.length; start += 7) {
        const chunk = keys.slice(start, start + 7);
        const count = chunk.reduce((sum, key) => sum + (byDate.get(key)?.total ?? 0), 0);
        rows.push({
          key: chunk[0],
          label: `${shortDateLabel(chunk[0])} – ${shortDateLabel(chunk[chunk.length - 1])}`,
          count
        });
      }
    }

    const types = Object.entries(typeTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({
        type,
        count,
        label: ANALYTICS_EVENT_LABELS[type as keyof typeof ANALYTICS_EVENT_LABELS] ?? type
      }));

    const last = events.length > 0 ? events[events.length - 1].timestamp : null;
    const topLabel = types.length > 0 ? `${types[0].label} ${types[0].count.toLocaleString("ko-KR")}건` : "없음";

    return {
      chartRows: rows,
      periodTotal: total,
      activeDays: active,
      typeRows: types,
      topTypeLabel: topLabel,
      lastEventAt: last
    };
  }, [events, days]);

  const chartMax = Math.max(...chartRows.map((row) => row.count), 1);

  function handleExportJson() {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `lcm-analytics-${localDateKey(Date.now())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus(`이벤트 ${events.length}개를 JSON으로 내보냈습니다.`);
  }

  async function handleClearAll() {
    if (!window.confirm(`애널리틱스 이벤트 ${events.length}개를 이 브라우저에서 모두 삭제할까요? 되돌릴 수 없습니다.`)) {
      return;
    }
    await clearEvents();
    setEvents([]);
    setStatus("애널리틱스 데이터를 삭제했습니다.");
  }

  return (
    <Card withBorder padding="md" radius="sm" component="section" aria-label="개인 기기에서 확인하는 통계">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div>
            <Text className="section-label" size="xs">
              내 브라우저 기록
            </Text>
            <Text fw={700}>개인 기기에서 확인하는 통계</Text>
          </div>
          <Group gap="xs">
            <Button variant="default" size="xs" onClick={() => void reload()}>
              새로고침
            </Button>
            <Button variant="default" size="xs" onClick={handleExportJson}>
              JSON 내보내기
            </Button>
            <Button variant="light" color="rose" size="xs" onClick={() => void handleClearAll()}>
              전체 삭제
            </Button>
          </Group>
        </Group>

      <Alert variant="light" color="teal" title="브라우저 안에서만 처리됩니다">
        <Text size="sm">
          이벤트는 이 브라우저의 IndexedDB(lcm-analytics)에만 저장되며 서버로 전송되지 않습니다. 최신 1,000개까지
          보관되고 오래된 이벤트부터 자동으로 삭제됩니다.
          위의 선택적 사용 통계 제공과 별개이며, 이를 켜도 이 기록을 업로드하지 않습니다.
        </Text>
      </Alert>

      {status ? (
        <Text size="xs" c="dimmed" role="status">
          {status}
        </Text>
      ) : null}

      <SegmentedControl
        size="xs"
        aria-label="집계 기간"
        value={range}
        onChange={(value) => setRange(value as AnalyticsRange)}
        data={[
          { value: "7", label: "최근 7일" },
          { value: "30", label: "최근 30일" }
        ]}
      />

      {events.length === 0 ? (
        <Text size="sm" c="dimmed">
          아직 수집된 이벤트가 없습니다. 고정비를 추가하거나 백업을 내보내면 이곳에 통계가 쌓입니다.
        </Text>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Card withBorder padding="md" radius="sm">
              <Text className="section-label" size="xs">
                기간 이벤트
              </Text>
              <Text fw={700} className="tnum">
                {periodTotal.toLocaleString("ko-KR")}건
              </Text>
            </Card>
            <Card withBorder padding="md" radius="sm">
              <Text className="section-label" size="xs">
                사용일
              </Text>
              <Text fw={700} className="tnum">
                {activeDays} / {days}일
              </Text>
            </Card>
            <Card withBorder padding="md" radius="sm">
              <Text className="section-label" size="xs">
                최다 이벤트
              </Text>
              <Text fw={700}>{topTypeLabel}</Text>
            </Card>
          </SimpleGrid>

          <div className="bars" aria-label={`기간별 이벤트 수 그래프 (${days}일)`}>
            {chartRows.map((row) => (
              <div className="bar-row" key={row.key}>
                <div className="bar-meta">
                  <span>{row.label}</span>
                  <strong className="tnum">{row.count.toLocaleString("ko-KR")}건</strong>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(row.count / chartMax) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>

          <div>
            <Text size="xs" c="dimmed" mb="xs">
              이벤트 타입별 집계 (기간 내)
            </Text>
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>이벤트</Table.Th>
                  <Table.Th ta="right">횟수</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {typeRows.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={2}>
                      <Text size="sm" c="dimmed">
                        이 기간에는 이벤트가 없습니다.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  typeRows.map((row) => (
                    <Table.Tr key={row.type}>
                      <Table.Td>
                        <Text size="sm">{row.label}</Text>
                        <Text size="xs" c="dimmed" className="tnum">
                          {row.type}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" className="tnum" ta="right">
                          {row.count.toLocaleString("ko-KR")}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
          </div>

          <Text size="xs" c="dimmed">
            저장된 이벤트 {events.length.toLocaleString("ko-KR")}개
            {lastEventAt !== null
              ? ` · 마지막 이벤트 ${new Date(lastEventAt).toLocaleString("ko-KR", { hour12: false })}`
              : ""}
          </Text>
        </>
      )}
      </Stack>
    </Card>
  );
}
