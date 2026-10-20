import { Button, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import type { UiTheme } from '@living-cost-manager/shared';
import { UI_THEME_IDS, themeAccents, type ThemeStatus } from '../lib/uiTheme';
const labels: Record<ThemeStatus, string> = {
  local: '이 사용자 정보에 적용됨 · 계정 저장 미확인', memory: '현재 화면에만 적용됨 · 브라우저 저장 불가',
  checking: '계정 설정 확인 중 · 현재 선택 유지', saving: '기기에 적용됨 · 계정 저장 중', saved: '계정에 저장됨', failed: '현재 선택 유지 · 계정 저장 확인 실패'
};
export function AppearanceSettings({ selected, status, choose, retry }: { selected: UiTheme; status: ThemeStatus; choose: (id: UiTheme) => void; retry: () => void }) {
  const { setColorScheme } = useMantineColorScheme();
  const mode = useComputedColorScheme('light', { getInitialValueInEffect: true });
  return <section className="appearance-settings quiet-card" aria-labelledby="appearance-title">
    <h2 id="appearance-title">화면 설정</h2>
    <p>포인트 색상은 내 사용자 정보에 저장됩니다. 공유 가계부와 재무 백업에는 포함되지 않아요.</p>
    <fieldset className="theme-choices"><legend>포인트 색상</legend>{UI_THEME_IDS.map(id => <button key={id} type="button" aria-pressed={selected === id} onClick={() => choose(id)}><span className="theme-swatch" style={{ background: themeAccents[id].primary }} aria-hidden="true" /><span>{themeAccents[id].name}</span><span aria-hidden="true">{selected === id ? '✓' : ''}</span></button>)}</fieldset>
    <p role="status" aria-live="polite">{labels[status]}</p>
    {status === 'failed' ? <Button variant="default" onClick={retry}>계정 저장 다시 확인</Button> : null}
    <div className="appearance-mode"><span>밝기 모드 · {mode === 'dark' ? '어둡게' : '밝게'}</span><Button variant="default" onClick={() => setColorScheme(mode === 'dark' ? 'light' : 'dark')}>{mode === 'dark' ? '밝게 보기' : '어둡게 보기'}</Button></div>
  </section>;
}
