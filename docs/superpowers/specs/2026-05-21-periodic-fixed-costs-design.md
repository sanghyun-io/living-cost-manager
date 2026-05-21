# Periodic Fixed Costs Design

## Goal

Extend the existing fixed-cost manager so some fixed-cost items can represent non-monthly recurring purchases, such as cat litter bought every 3 months or car insurance paid once a year.

The user-facing concept remains "고정비 항목". Internally, each item gains a recurrence period in months. A normal monthly fixed cost is simply an item with a 1-month period.

## Scope

This design covers:

- Adding a period-in-months value to fixed-cost items.
- Treating the entered amount as the one-time payment amount.
- Calculating monthly budget pressure as `Math.round(amount / periodMonths)`.
- Showing monthly-equivalent totals in summaries, filters, and charts.
- Keeping the existing category, payment method, payment option, card, import, export, and delete-mode behavior compatible.

This design does not cover:

- Last purchase date.
- Next purchase date.
- Automatic "this month purchase due" reminders.
- Separate actual-spend logging.
- Cashflow spikes in the exact month an item is purchased.

Those can be added later once the monthly-equivalent model is stable.

## Data Model

`FixedCost` gains:

- `periodMonths: number`

Rules:

- Default value is `1`.
- Minimum valid value is `1`.
- Existing stored items without this field are normalized to `1`.
- The entered `amount` remains the amount paid each time the item is purchased or billed.
- The monthly-equivalent amount is calculated as `Math.round(amount / periodMonths)` so displayed Korean won values stay as whole numbers.

Examples:

| Item | Amount | Period | Monthly Equivalent |
| --- | ---: | ---: | ---: |
| 월세 | 650000 | 1 month | 650000 |
| 고양이 모래 | 45000 | 3 months | 15000 |
| 자동차 보험 | 1200000 | 12 months | 100000 |

## UI

The section title remains "고정비 항목".

The item list adds:

- `주기`: editable month interval, default `1`.
- `월 환산`: read-only calculated amount.

The table columns become:

- 항목
- 카테고리
- 결제수단
- 결제 옵션
- 납부일
- 금액
- 주기
- 월 환산
- 관리

The amount input keeps the existing thousand-separator formatting. The period input should be compact and numeric, because it is a budget parameter rather than a free-form label.

## Summary Behavior

All monthly budget summaries use monthly-equivalent amounts:

- Main fixed-cost total.
- Remaining amount after fixed costs.
- Income-to-fixed-cost ratio.
- Average fixed cost.
- Category totals.
- Category filter visible total.
- Bar chart values.
- Pie chart values and hover tooltip amounts.

Labels should make the meaning clear without renaming the main section:

- Use "월 환산 고정비" for the main monthly total.
- Use "월 환산" for calculated per-item values.
- Keep "고정비 항목" for the editable list.

## Import and Export

CSV template import/export should include a period column.

Full `.lcm` import/export should include the period value in the fixed-cost section.

Compatibility rules:

- Imported rows without period default to `1`.
- Invalid, empty, or less-than-1 periods default to `1`.
- Existing `.lcm` backups without the period field continue to import.

## Error Handling

The app should avoid blocking user editing for minor numeric issues.

- Empty period input is treated as `1` once normalized.
- Non-numeric period input is treated as `1`.
- Decimal periods are parsed as an integer month count by truncating the decimal part.
- Amount remains parsed through the existing currency input parser.

## Testing

Update unit tests for:

- Creating fixed costs with default `periodMonths = 1`.
- Monthly-equivalent summary calculation.
- Category bucket totals using monthly-equivalent values.
- Pie segment totals using monthly-equivalent values.
- Backup export/import preserving `periodMonths`.
- Backward compatibility for old backup data without `periodMonths`.
- CSV template import/export with the new period column.

Update smoke tests if rendered table labels or summary labels change.

## Future Extensions

Later work can add due-date behavior:

- `lastPurchasedAt`
- `nextDueAt`
- monthly cashflow forecast
- "이번 달 구매 예정" list
- converting a planned periodic purchase into an actual spend record

These should not be implemented in this step, because they require a different model from monthly-equivalent budgeting.
