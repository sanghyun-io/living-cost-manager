"use client";
import { useRef, useState } from 'react';
import { Button, Checkbox, Group, Text, TextInput } from '@mantine/core';
import type { WorkspaceDto } from '@living-cost-manager/shared';
import type { ServerSession } from '../lib/serverApi';
import type { useLedgers } from '../lib/useLedgers';
import type { FocusDestination, FocusIntentHandler } from '../lib/focusIntent';
import { FREE_PUBLIC_RELEASE, CROSS_LEDGER_AGGREGATION_AVAILABLE } from '../lib/publicRelease';

export function LedgerControls({ session, workspaces, onSwitch, ledgers, canSwitch, onFocusIntent, focusRef }: {
  session: ServerSession; workspaces: WorkspaceDto[]; onSwitch: (id: string) => Promise<void>;
  ledgers: ReturnType<typeof useLedgers>; canSwitch: boolean;
  onFocusIntent: FocusIntentHandler; focusRef: (destination: FocusDestination, element: HTMLElement | null) => void;
}) {
  const [action, setAction] = useState<'create' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const draftRevision = useRef(0);
  return <div className="ledger-controls" aria-label="가계부 관리">
    <Group gap="sm" wrap="wrap">
      <label className="ledger-selector">현재 가계부
        <select ref={element => focusRef('ledger', element)} aria-label="현재 가계부" value={session.workspace?.id ?? ''} disabled={!canSwitch} onChange={e => {
          const id = e.currentTarget.value, done = onFocusIntent('ledger', e.currentTarget, id);
          void onSwitch(id).then(() => done()).catch(() => done(false));
        }}>
          {!session.workspace ? <option value="">가계부 선택</option> : null}
          {(workspaces.length ? workspaces : session.workspace ? [session.workspace] : []).map(value => <option key={value.id} value={value.id}>{value.name}{value.role === 'viewer' ? ' · 보기 전용' : ''}</option>)}
        </select>
      </label>
      {ledgers.canCreate ? <Button ref={element => focusRef('create', element)} variant="subtle" disabled={!canSwitch || !session.user.emailVerified || ledgers.busy || ledgers.uncertain} onClick={() => { draftRevision.current++; setAction('create'); setName(''); }}>새 가계부</Button> : null}
      <Button ref={element => focusRef('rename', element)} variant="subtle" disabled={!canSwitch || session.workspace?.role !== 'owner' || !session.user.emailVerified || ledgers.busy || ledgers.uncertain} onClick={() => { draftRevision.current++; setAction('rename'); setName(session.workspace?.name ?? ''); }}>이름 변경</Button>
      {CROSS_LEDGER_AGGREGATION_AVAILABLE ? <Checkbox label="합산 보기" checked={ledgers.aggregateMode} onChange={e => ledgers.setAggregateMode(e.currentTarget.checked)} /> : null}
      <Button variant="subtle" onClick={() => void ledgers.refresh()} disabled={ledgers.busy}>가계부 목록 새로고침</Button>
    </Group>
    {!session.user.emailVerified ? <Text size="xs">첫 가계부 생성과 이름 변경은 이메일 확인 후 사용할 수 있습니다.</Text> : null}
    {action ? <form onFocusCapture={() => { draftRevision.current++; }} onPointerDownCapture={() => { draftRevision.current++; }}
      onKeyDownCapture={e => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) draftRevision.current++; }} onSubmit={e => {
      e.preventDefault();
      const focused = e.currentTarget.ownerDocument.activeElement;
      // The first-create button disappears after success in the free release.
      // Return keyboard focus to the stable selector, not a removed control.
      const destination = action === 'create' && FREE_PUBLIC_RELEASE ? 'ledger' : action;
      const done = onFocusIntent(destination, focused instanceof HTMLElement && e.currentTarget.contains(focused) ? focused : e.currentTarget);
      const submittedRevision = draftRevision.current;
      void (action === 'create' ? ledgers.create(name) : ledgers.rename(name)).then(result => {
        // A completed request must not remove a field the user has returned to
        // or edited while waiting. Keep that newer draft and its current focus.
        if (draftRevision.current !== submittedRevision) { done(false); return; }
        if (result !== false) setAction(null);
        done(result !== false);
      }).catch(() => done(false));
    }}>
      <Group align="end" mt="sm"><TextInput label={action === 'create' ? '새 가계부 이름' : '가계부 이름'} maxLength={100} required value={name} onChange={e => { draftRevision.current++; setName(e.currentTarget.value); }} />
      <Button type="submit" disabled={ledgers.busy || (action === 'create' && (ledgers.uncertain || !ledgers.canCreate)) || !canSwitch}>확인</Button><Button variant="default" onClick={e => {
        draftRevision.current++;
        const done = onFocusIntent(action, e.currentTarget);
        setAction(null); done();
      }}>취소</Button></Group>
    </form> : null}
    {ledgers.status ? <Text role="status" size="sm" mt="sm">{ledgers.status}</Text> : null}
    {ledgers.uncertain ? <section aria-label="생성 결과 확인"><Text size="sm">미확인 생성 이름: {ledgers.uncertainName}. 새로고침만으로 실패를 확정하지 않습니다.</Text>
      {ledgers.reconciliationReady ? <ul>{workspaces.map(value => <li key={value.id}>{value.name}</li>)}</ul> : null}
      <Button variant="default" disabled={!ledgers.reconciliationReady || ledgers.mutationPending} onClick={ledgers.acknowledgeReconciliation}>목록을 직접 확인했고 지연 완료·중복 위험을 이해합니다</Button>
    </section> : null}
    {CROSS_LEDGER_AGGREGATION_AVAILABLE && ledgers.aggregateMode ? <fieldset className="ledger-aggregate-selection"><legend>합산할 가계부를 직접 선택하세요 (최대 20개)</legend>
      <Group>{workspaces.map(value => <Checkbox key={value.id} label={value.name} checked={ledgers.selected.includes(value.id)} disabled={ledgers.busy || (!ledgers.selected.includes(value.id) && ledgers.selected.length >= 20)} onChange={e => ledgers.select(e.currentTarget.checked ? [...ledgers.selected, value.id] : ledgers.selected.filter(id => id !== value.id))} />)}</Group>
      <Button ref={element => focusRef('aggregate', element)} mt="sm" disabled={!ledgers.selected.length || ledgers.busy} onClick={e => {
        const done = onFocusIntent('aggregate', e.currentTarget);
        void ledgers.loadAggregate().then(() => done()).catch(() => done(false));
      }}>선택한 가계부 합산 조회</Button>
    </fieldset> : null}
  </div>;
}
