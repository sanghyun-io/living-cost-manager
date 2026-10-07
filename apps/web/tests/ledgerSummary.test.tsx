import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { expect, it } from 'vitest';
import { LedgerSummary } from '../app/components/LedgerSummary';
it('aggregate never displays server income/residual/ratio, labels unknown and duplicate charges honestly', () => {
  // Even an older server's extra income field must never be rendered.
  const summary = { monthlyIncome: 99999999, monthlyNormalizedExpense: 66.666, fixedCostCount: 2, knownScheduleCount: 0, unknownScheduleCount: 2, dueOccurrenceCount: 0, thirtyDayDue: null };
  const html = renderToStaticMarkup(<MantineProvider><LedgerSummary aggregate fromDate="2026-10-07" untilDateExclusive="2026-11-06" summary={summary} /></MantineProvider>);
  expect(html).not.toContain('99,999,999'); expect(html).toContain('67원'); expect(html).toContain('일정 미확인');
  expect(html).toContain('각각 합산'); expect(html).toContain('읽기 전용'); expect(html).toContain('결제 완료액 아님');
});
