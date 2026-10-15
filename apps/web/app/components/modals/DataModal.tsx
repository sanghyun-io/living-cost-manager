import { Alert, Button, Card, Group, SimpleGrid, Text } from "@mantine/core";
import type { DataModalProps } from "../../lib/pageTypes";
import { ModalShell } from "./ModalShell";
import { ServerSyncPanel } from "./ServerSyncPanel";
import { MarketingConsentControl } from "../MarketingConsentControl";
import { formatWon } from "../../lib/formatting";

export function DataModal({
  marketingConsent,
  importPreview, importMessage, onApplyImport, onCancelImport,
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
          <Text className="section-label" size="xs">항목 CSV</Text>
          <Group gap="xs" mt="sm">
            <Button variant="default" size="xs" onClick={onExportTemplate} aria-label="항목 CSV 내보내기">
              내보내기
            </Button>
            <Button variant="default" size="xs" onClick={() => importFileRef.current?.click()} aria-label="항목 CSV 가져오기">
              가져오기
            </Button>
          </Group>
        </Card>
        <Card withBorder padding="md" radius="sm">
          <Text className="section-label" size="xs">전체 백업(.lcm)</Text>
          <Group gap="xs" mt="sm">
            <Button variant="default" size="xs" onClick={onExportBackup} aria-label="전체 백업 내보내기">
              내보내기
            </Button>
            <Button variant="default" size="xs" onClick={() => backupFileRef.current?.click()} aria-label="전체 백업 가져오기">
              가져오기
            </Button>
          </Group>
        </Card>
      </SimpleGrid>
      {importMessage ? <Text role="status">{importMessage}</Text> : null}
      {importPreview ? (
        <Alert title="가져오기 미리보기" color="yellow">
          <Text>현재 {importPreview.currentCount}개 · 월 {formatWon(importPreview.currentAmount)}</Text>
          <Text>가져올 {importPreview.targetCount}개 · 월 {formatWon(importPreview.targetAmount)}</Text>
          <Text size="sm" mt="xs">적용하면 현재 데이터를 교체합니다. 교체 전 복구 사본을 보관합니다.</Text>
          <Group mt="sm">
            <Button onClick={onApplyImport}>교체 적용</Button>
            <Button variant="default" onClick={onCancelImport}>취소</Button>
          </Group>
        </Alert>
      ) : null}
      {hasServerApi ? (
        <ServerSyncPanel sync={sync} sharing={sharing} />
      ) : (
        <Alert variant="light" color="yellow" title="이 기기에만 저장됩니다">
          <Text size="sm">브라우저 데이터를 삭제하면 기기에 저장한 내용도 사라집니다. 전체 백업을 보관하세요.</Text>
        </Alert>
      )}
      <MarketingConsentControl {...marketingConsent} />
      <input
        ref={importFileRef}
        aria-label="CSV 파일 가져오기"
        className="sr-only"
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => onImportTemplate(event.target.files?.[0] ?? null)}
      />
      <input
        ref={backupFileRef}
        aria-label="전체 백업 파일 가져오기"
        className="sr-only"
        type="file"
        accept=".lcm,text/plain"
        onChange={(event) => onImportBackup(event.target.files?.[0] ?? null)}
      />
    </ModalShell>
  );
}
