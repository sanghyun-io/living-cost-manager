import type { DataModalProps } from "../../lib/pageTypes";
import { ModalShell } from "./ModalShell";
import { ServerSyncPanel } from "./ServerSyncPanel";

export function DataModal({
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
    <ModalShell titleId="data-modal-title" sectionLabel="관리" title="데이터 관리" className="data-modal" onClose={onClose}>
      <div className="data-action-grid">
        <section className="data-action-panel">
          <div>
            <p className="section-label">엑셀 템플릿</p>
            <h3>항목 일괄 편집</h3>
            <small>고정비 항목만 CSV로 편집합니다.</small>
          </div>
          <div className="data-action-buttons">
            <button className="secondary-button" type="button" onClick={onExportTemplate}>
              템플릿 Export
            </button>
            <button className="secondary-button" type="button" onClick={() => importFileRef.current?.click()}>
              Import
            </button>
          </div>
        </section>
        <section className="data-action-panel">
          <div>
            <p className="section-label">LCM 백업</p>
            <h3>전체 백업</h3>
            <small>수입, 카테고리, 카드, 고정비를 모두 저장합니다.</small>
          </div>
          <div className="data-action-buttons">
            <button className="secondary-button" type="button" onClick={onExportBackup}>
              전체 Export
            </button>
            <button className="secondary-button" type="button" onClick={() => backupFileRef.current?.click()}>
              전체 Import
            </button>
          </div>
        </section>
      </div>
      {hasServerApi ? (
        <ServerSyncPanel sync={sync} sharing={sharing} />
      ) : (
        <div className="local-mode-warning" role="status">
          <strong>서버 API URL이 없어 로컬 전용으로 동작합니다.</strong>
          <p>이 브라우저에만 저장되며, 브라우저 데이터 삭제나 기기 교체 시 복구할 수 없습니다. 전체 Export 백업을 보관하세요.</p>
          <button className="secondary-button" type="button" onClick={onExportBackup}>
            전체 Export 백업
          </button>
        </div>
      )}
      <p className="local-note">브라우저 저장은 항상 유지됩니다. 서버 동기화와 별도로 기기를 바꾸기 전에는 전체 Export로 백업하세요.</p>
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
