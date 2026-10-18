import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { BudgetStrip } from '../app/components/BudgetStrip';
import { AppHeader } from '../app/components/AppHeader';
import { createFixedCost } from '../app/lib/budget';
import { buildHomePlan } from '../app/lib/homePlan';

const asOf = new Date('2026-10-09T15:00:00Z');

// 첫 화면 금액은 전부 homePlan 한 곳에서 파생된다(컴포넌트 내부 재계산 없음).
function strip(income = 3000000, canEdit = true, known = true) {
  const cost = createFixedCost({ id: 'synthetic', name: '테스트', amount: 12000, periodMonths: 1, billingDay: 15 });
  const fixedCosts = [{ ...cost, billingAnchorDate: known ? '2026-10-15' : null }];
  return renderToStaticMarkup(<MantineProvider><BudgetStrip
    plan={buildHomePlan(fixedCosts, income, asOf)}
    canEdit={canEdit} onIncomeChange={vi.fn()} /></MantineProvider>);
}

test('plan surface shows normalization and disposable plan once, dues live on the canonical list', () => {
  const html = strip();
  expect(html).toContain('월 환산 고정비');
  expect(html).toContain('고정비 제외 계획금액');
  expect(html).toContain('₩2,988,000');
  expect(html).toContain('변동지출·실제잔액 미반영');
  // 30일 청구 합계·납부 목록의 정본은 UpcomingDues(upcomingDues.test.tsx 에서 검증).
  expect(html).not.toContain('다음 30일 예정 청구');
  expect(html).not.toContain('수입 미입력');
  expect(html.match(/고정비 제외 계획금액/g)).toHaveLength(1);
});

test('income 0 is displayed as the stored 0 without unset claims or a negative headline', () => {
  const html = strip(0);
  expect(html).toContain('월수입 ₩0 기준');
  expect(html).not.toContain('-12,000');
  expect(html).not.toContain('미입력');
  expect(html).not.toContain('role="alert"');
});

test('entered income below fixed costs shows the negative plan without an error role', () => {
  const html = strip(10000);
  expect(html).toContain('-₩2,000');
  expect(html).not.toContain('role="alert"');
});

test('unknown schedules keep the plan fact intact and belong to the dues surface', () => {
  // 일정 미확인 표시(합계·건수)는 UpcomingDues 정본으로 이동했다.
  expect(strip(3000000, true, false)).not.toContain('일정 미확인');
});

test('viewer summary preserves income value but disables its input', () => {
  expect(strip(3000000, false)).toMatch(/<input[^>]*disabled/);
});

test('income input carries an explicit mobile-friendly inputmode, not an invented prop', () => {
  const html = strip();
  expect(html).toMatch(/<input[^>]*inputmode="numeric"/i);
  expect(html).toMatch(/<input[^>]*id="monthly-income"/);
  expect(html).not.toContain('type="number"');
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
