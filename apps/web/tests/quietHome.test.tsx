import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { BudgetStrip } from '../app/components/BudgetStrip';
import { AppHeader } from '../app/components/AppHeader';
import { createFixedCost } from '../app/lib/budget';

function strip(income = 3000000, canEdit = true, known = true) {
  const cost = createFixedCost({ id: 'synthetic', name: '테스트', amount: 12000, periodMonths: 1, billingDay: 15 });
  return renderToStaticMarkup(<MantineProvider><BudgetStrip monthlyIncome={income} monthlyExpense={12000}
    fixedCosts={[{ ...cost, billingAnchorDate: known ? '2026-10-15' : null }]} asOf={new Date('2026-10-09T15:00:00Z')}
    canEdit={canEdit} onIncomeChange={vi.fn()} /></MantineProvider>);
}

test('compact summary distinguishes monthly normalization, disposable balance and forecast', () => {
  const html = strip();
  expect(html).toContain('월 환산 고정비');
  expect(html).toContain('고정비 제외 잔액');
  expect(html).toContain('₩2,988,000');
  expect(html).toContain('다음 30일 예정 청구');
  expect(html).toContain('결제 완료액이 아닙니다');
  expect(html).toContain('2026-10-10');
  expect(html).toContain('2026-11-09');
  expect(html).not.toContain('고정비와 다음 결제');
});

test('missing income is not presented as a negative disposable balance', () => {
  expect(strip(0)).toContain('수입 미입력');
  expect(strip(0)).not.toContain('₩-12,000');
});

test('unknown schedules remain explicitly unknown, not zero paid expenses', () => {
  expect(strip(3000000, true, false)).toContain('일정 미확인 1건');
  expect(strip(3000000, true, false)).toContain('일정 미확인</p>');
});

test('viewer summary preserves income value but disables its input', () => {
  expect(strip(3000000, false)).toMatch(/<input[^>]*disabled/);
});

test('save failures keep retry and unsaved export outside secondary menus', () => {
  const noop = vi.fn();
  const html = renderToStaticMarkup(<MantineProvider><AppHeader saveError="저장 실패" recoveryRequired={false}
    lastSavedAt={null} serverSession={null} currentUserName="테스트" onRetrySave={noop} onExportUnsaved={noop}
    onOpenData={noop} onOpenAuth={noop} onOpenCoach={noop} onOpenTemplates={noop} onServerLogout={noop} /></MantineProvider>);
  expect(html).toContain('role="alert"');
  expect(html).toContain('브라우저 저장 재시도');
  expect(html).toContain('미저장 데이터 내보내기');
  expect(html).toContain('데이터 관리');
  expect(html).toContain('로그인');
});
