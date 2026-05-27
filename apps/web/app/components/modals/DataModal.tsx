import { Alert, Button, Card, Group, SimpleGrid, Text } from "@mantine/core";
import type { DataModalProps } from "../../lib/pageTypes";
import { ModalShell } from "./ModalShell";
import { ServerSyncPanel } from "./ServerSyncPanel";

export function DataModal({
  opened,
  hasServerApi,
  importFileRef,
  backupFileRef,
  onClose,
  onExportTemplate,
  onImportTemplate,
  onExportBackup,
  onImportBackup,
  sync,
  sharing
}: DataModalProps) {
  return (
    <ModalShell opened={opened} sectionLabel="관리" title="데이터 관리" size="lg" onClose={onClose}>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder padding="md" radius="sm">
          <Text className="section-label" size="xs">엑셀 템플릿</Text>
          <Text fw={700}>항목 일괄 편집</Text>
          <Text size="xs" c="dimmed" mb="sm">고정비 항목만 CSV로 편집합니다.</Text>
          <Group gap="xs">
            <Button variant="default" size="xs" onClick={onExportTemplate}>
              템플릿 Export
            </Button>
            <Button variant="default" size="xs" onClick={() => importFileRef.current?.click()}>
              Import
            </Button>
          </Group>
        </Card>
        <Card withBorder padding="md" radius="sm">
          <Text className="section-label" size="xs">LCM 백업</Text>
          <Text fw={700}>전체 백업</Text>
          <Text size="xs" c="dimmed" mb="sm">수입, 카테고리, 카드, 고정비를 모두 저장합니다.</Text>
          <Group gap="xs">
            <Button variant="default" size="xs" onClick={onExportBackup}>
              전체 Export
            </Button>
            <Button variant="default" size="xs" onClick={() => backupFileRef.current?.click()}>
              전체 Import
            </Button>
          </Group>
        </Card>
      </SimpleGrid>
      {hasServerApi ? (
        <ServerSyncPanel sync={sync} sharing={sharing} />
      ) : (
        <Alert variant="light" color="yellow" title="서버 API URL이 없어 로컬 전용으로 동작합니다.">
          <Text size="sm" mb="sm">
            이 브라우저에만 저장되며, 브라우저 데이터 삭제나 기기 교체 시 복구할 수 없습니다. 전체 Export 백업을 보관하세요.
          </Text>
          <Button variant="default" size="xs" onClick={onExportBackup}>
            전체 Export 백업
          </Button>
        </Alert>
      )}
      <Text size="xs" c="dimmed">
        브라우저 저장은 항상 유지됩니다. 서버 동기화와 별도로 기기를 바꾸기 전에는 전체 Export로 백업하세요.
      </Text>
      <input
        ref={importFileRef}
        className="sr-only"
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => onImportTemplate(event.target.files?.[0] ?? null)}
      />
      <input
        ref={backupFileRef}
        className="sr-only"
        type="file"
        accept=".lcm,text/plain"
        onChange={(event) => onImportBackup(event.target.files?.[0] ?? null)}
      />
    </ModalShell>
  );
}
