"use client";
import { useState } from 'react';
import { Button, Checkbox, Group, Text, TextInput } from '@mantine/core';
import type { WorkspaceDto } from '@living-cost-manager/shared';
import type { ServerSession } from '../lib/serverApi';
import type { useLedgers } from '../lib/useLedgers';
import type { FocusDestination, FocusIntentHandler } from '../lib/focusIntent';

export function LedgerControls({ session, workspaces, onSwitch, ledgers, canSwitch, onFocusIntent, focusRef }: {
  session: ServerSession; workspaces: WorkspaceDto[]; onSwitch: (id: string) => Promise<void>;
  ledgers: ReturnType<typeof useLedgers>; canSwitch: boolean;
  onFocusIntent: FocusIntentHandler; focusRef: (destination: FocusDestination, element: HTMLElement | null) => void;
}) {
  const [action, setAction] = useState<'create' | 'rename' | null>(null);
  const [name, setName] = useState('');
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
      <Button ref={element => focusRef('create', element)} variant="subtle" disabled={!canSwitch || !session.user.emailVerified || ledgers.busy || ledgers.uncertain} onClick={() => { setAction('create'); setName(''); }}>새 가계부</Button>
      <Button ref={element => focusRef('rename', element)} variant="subtle" disabled={!canSwitch || session.workspace?.role !== 'owner' || !session.user.emailVerified || ledgers.busy || ledgers.uncertain} onClick={() => { setAction('rename'); setName(session.workspace?.name ?? ''); }}>이름 변경</Button>
      <Checkbox label="합산 보기" checked={ledgers.aggregateMode} onChange={e => ledgers.setAggregateMode(e.currentTarget.checked)} />
      <Button variant="subtle" onClick={() => void ledgers.refresh()} disabled={ledgers.busy}>가계부 목록 새로고침</Button>
    </Group>
    {!session.user.emailVerified ? <Text size="xs">새 가계부와 이름 변경은 이메일 확인 후 사용할 수 있습니다.</Text> : null}
    {action ? <form onSubmit={e => {
      e.preventDefault();
      const done = onFocusIntent(action, e.currentTarget);
      void (action === 'create' ? ledgers.create(name) : ledgers.rename(name)).then(result => {
        if (result !== false) setAction(null);
        done(result !== false);
      }).catch(() => done(false));
    }}>
      <Group align="end" mt="sm"><TextInput label={action === 'create' ? '새 가계부 이름' : '가계부 이름'} maxLength={100} required value={name} onChange={e => setName(e.currentTarget.value)} />
      <Button type="submit" disabled={ledgers.busy || (action === 'create' && ledgers.uncertain) || !canSwitch}>확인</Button><Button variant="default" onClick={e => {
        const done = onFocusIntent(action, e.currentTarget.closest('form')!);
        setAction(null); done();
      }}>취소</Button></Group>
    </form> : null}
    {ledgers.status ? <Text role="status" size="sm" mt="sm">{ledgers.status}</Text> : null}
    {ledgers.uncertain ? <section aria-label="생성 결과 확인"><Text size="sm">미확인 생성 이름: {ledgers.uncertainName}. 새로고침만으로 실패를 확정하지 않습니다.</Text>
      {ledgers.reconciliationReady ? <ul>{workspaces.map(value => <li key={value.id}>{value.name}</li>)}</ul> : null}
      <Button variant="default" disabled={!ledgers.reconciliationReady || ledgers.mutationPending} onClick={ledgers.acknowledgeReconciliation}>목록을 직접 확인했고 지연 완료·중복 위험을 이해합니다</Button>
    </section> : null}
    {ledgers.aggregateMode ? <fieldset className="ledger-aggregate-selection"><legend>합산할 가계부를 직접 선택하세요 (최대 20개)</legend>
      <Group>{workspaces.map(value => <Checkbox key={value.id} label={value.name} checked={ledgers.selected.includes(value.id)} disabled={ledgers.busy || (!ledgers.selected.includes(value.id) && ledgers.selected.length >= 20)} onChange={e => ledgers.select(e.currentTarget.checked ? [...ledgers.selected, value.id] : ledgers.selected.filter(id => id !== value.id))} />)}</Group>
      <Button ref={element => focusRef('aggregate', element)} mt="sm" disabled={!ledgers.selected.length || ledgers.busy} onClick={e => {
        const done = onFocusIntent('aggregate', e.currentTarget);
        void ledgers.loadAggregate().then(() => done()).catch(() => done(false));
      }}>선택한 가계부 합산 조회</Button>
    </fieldset> : null}
  </div>;
}
