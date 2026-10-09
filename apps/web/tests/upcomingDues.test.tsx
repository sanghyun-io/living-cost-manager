import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { expect, test } from 'vitest';
import { UpcomingDues } from '../app/components/UpcomingDues';
import { createFixedCost, type FixedCost } from '../app/lib/budget';

const asOf = new Date('2026-10-09T15:00:00Z'); // October 10 in Korea.
const known = { ...createFixedCost({ id: 'known', name: '확인된 지출', amount: 12000, periodMonths: 1, billingDay: 15 }), billingAnchorDate: '2026-10-15' };
const render = (fixedCosts: FixedCost[]) => renderToStaticMarkup(<MantineProvider><UpcomingDues fixedCosts={fixedCosts} asOf={asOf} /></MantineProvider>);

test('missing/invalid anchors and unsupported periods are unknown, never an empty forecast', () => {
  for (const patch of [{ billingAnchorDate: null }, { billingAnchorDate: '2026-02-30' }, { periodMonths: 0.5 }, { periodMonths: 0 }, { periodMonths: 121 }]) {
    const html = render([{ ...known, ...patch }]);
    expect(html).toContain('일정 미확인 1개');
    expect(html).not.toContain('30일 이내 납부 예정이 없습니다');
  }
  expect(render([{ ...known, amount: 0, billingAnchorDate: null }])).not.toContain('일정 미확인');
});

test('known future-only schedules permit empty text; mixed forecasts retain dues and unknown tally', () => {
  expect(render([{ ...known, billingAnchorDate: '2027-01-15' }])).toContain('30일 이내 납부 예정이 없습니다');
  const html = render([known, { ...known, id: 'missing', name: '미확인 지출', billingAnchorDate: null }]);
  expect(html).toContain('확인된 지출');
  expect(html).toContain('5일 후');
  expect(html).toContain('일정 미확인 1개');
  expect(html).not.toContain('30일 이내 납부 예정이 없습니다');
});
