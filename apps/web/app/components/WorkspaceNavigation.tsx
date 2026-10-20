export type WorkspaceView = 'home' | 'items' | 'plan' | 'review' | 'settings';
const destinations: { id: WorkspaceView; label: string; icon: string }[] = [
  { id: 'home', label: '홈', icon: '⌂' }, { id: 'items', label: '항목', icon: '☷' },
  { id: 'plan', label: '계획', icon: '▦' }, { id: 'review', label: '검토', icon: '◷' },
  { id: 'settings', label: '설정', icon: '⚙' }
];
export function WorkspaceNavigation({ view, onChange }: { view: WorkspaceView; onChange: (view: WorkspaceView) => void }) {
  return <>
    <aside className="workspace-sidebar">
      <div className="workspace-brand"><b>생활비 관리자</b><span>기록하고, 다음을 준비해요</span></div>
      <nav aria-label="작업 메뉴">{destinations.map(item => <button type="button" key={item.id} aria-current={view === item.id ? 'page' : undefined} onClick={() => onChange(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>
      <p className="workspace-sidebar-note">예산은 계획이에요.<br />실제 계좌 잔액과 다릅니다.</p>
    </aside>
    <nav className="workspace-bottom-nav" aria-label="모바일 작업 메뉴">{destinations.slice(0, 4).map(item => <button type="button" key={item.id} aria-current={view === item.id ? 'page' : undefined} onClick={() => onChange(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>
  </>;
}
