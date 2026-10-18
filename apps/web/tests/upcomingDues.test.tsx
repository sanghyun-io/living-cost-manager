import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { UpcomingDues } from '../app/components/UpcomingDues';
import { createFixedCost, type FixedCost } from '../app/lib/budget';
import { buildHomePlan } from '../app/lib/homePlan';

const asOf = new Date('2026-10-09T15:00:00Z'); // October 10 in Korea.
const known = { ...createFixedCost({ id: 'known', name: '확인된 지출', amount: 12000, periodMonths: 1, billingDay: 15 }), billingAnchorDate: '2026-10-15' };
const render = (fixedCosts: FixedCost[]) => renderToStaticMarkup(<MantineProvider><UpcomingDues fixedCosts={fixedCosts} asOf={asOf} /></MantineProvider>);

test('missing/invalid anchors and unsupported periods are unknown, never an empty forecast', () => {
  for (const patch of [{ billingAnchorDate: null }, { billingAnchorDate: '2026-02-30' }, { periodMonths: 0.5 }, { periodMonths: 0 }, { periodMonths: 121 }]) {
    const html = render([{ ...known, ...patch }]);
    expect(html).toContain('일정 미확인 1개');
    expect(html).not.toContain('30일 이내 납부 예정이 없습니다');
  }
  // 금액 0원 항목은 '미확인'으로 계상되지 않는다(도움말 문구의 일반 명사와 무관하게 건수 표시 없음).
  const zeroAmount = render([{ ...known, amount: 0, billingAnchorDate: null }]);
  expect(zeroAmount).not.toContain('일정 미확인 1');
  expect(zeroAmount).toContain('예정액 기준');
});

test('known future-only schedules permit empty text; mixed forecasts retain dues and unknown tally', () => {
  expect(render([{ ...known, billingAnchorDate: '2027-01-15' }])).toContain('30일 이내 납부 예정이 없습니다');
  const html = render([known, { ...known, id: 'missing', name: '미확인 지출', billingAnchorDate: null }]);
  expect(html).toContain('확인된 지출');
  expect(html).toContain('5일 후');
  expect(html).toContain('일정 미확인 1개');
  expect(html).not.toContain('30일 이내 납부 예정이 없습니다');
});

// 첫 화면 정본 계약: BudgetStrip에서 이동한 30일 합계·창/help 문구가 여기서만 보인다.
test('canonical 30-day total, window help and paid-not message live here exactly once', () => {
  const html = render([known]);
  expect(html).toContain('다음 30일 예정 청구');
  expect(html.match(/다음 30일 예정 청구/g)).toHaveLength(1);
  expect(html).toContain('₩12,000');
  expect(html).toContain('결제 완료액이 아닙니다');
  expect(html).toContain('2026-10-10');
  expect(html).toContain('2026-11-09');
  expect(html).toContain('확인된 일정 1회 청구');
  expect(html).not.toContain('일정 미입력');
});

test('quarterly actual charge total is not confused with the monthly normalization', () => {
  const quarterly = { ...createFixedCost({ id: 'q', name: '분기 결제', amount: 300000, periodMonths: 3, billingDay: 15 }), billingAnchorDate: '2026-10-15' };
  const plan = buildHomePlan([quarterly], 1000000, asOf);
  const html = renderToStaticMarkup(<MantineProvider><UpcomingDues fixedCosts={[quarterly]} asOf={asOf} plan={plan} /></MantineProvider>);
  // 실제 청구액 300,000이 예정 합계이고, 월 환산 100,000은 계획금액 계산에만 쓰인다.
  expect(html).toContain('₩300,000');
  expect(html).not.toContain('₩100,000');
});

test('rows expose a reveal action bound to the single reveal handler', () => {
  const onRevealItem = vi.fn();
  const html = renderToStaticMarkup(<MantineProvider><UpcomingDues fixedCosts={[known]} asOf={asOf} onRevealItem={onRevealItem} /></MantineProvider>);
  expect(html).toContain('항목 관리에서 보기');
  // 콜백 미전달(분석 위젯 등 재사용) 행에서는 버튼이 없다 — DOM 복제도 없다.
  expect(render([known])).not.toContain('항목 관리에서 보기');
});
