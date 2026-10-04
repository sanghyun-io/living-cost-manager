# Private weekly evidence toolkit

Standalone Node.js 20+; built-ins only, no installation, network calls, credentials,
OAuth, cookies, database access, paid resources, or runtime collection. This is an
offline reporting tool, not the separately implemented default-off runtime pipeline.

## Run

From repository root, generate a first all-unknown report without any production
access or synthetic marketing statistics:

```sh
mkdir -p marketing-private
chmod 700 marketing-private
cp scripts/marketing/empty-week.example.json marketing-private/manifest.json
chmod 600 marketing-private/manifest.json
node scripts/marketing/evidence.mjs --manifest marketing-private/manifest.json --out marketing-private/readiness-20261005
```

The example contains no observations and no baseline. `observed` describes the
intended input class, not proof of any observation: `inputs: []` produces an
explicit no-observations statement, unknown baseline, and header-only metric CSV.
Change period dates for future reports; add actual private input files only when
available. Keep an existing manifest rather than copying over it on later weeks.
Coordinator excludes `marketing-private/` in both `.gitignore` and `.dockerignore`.

```sh
node --test scripts/marketing/evidence.test.mjs
node scripts/marketing/evidence.mjs --manifest /PRIVATE/marketing/manifest.json --out /PRIVATE/marketing/week-2026-10-04
```

The output directory must not exist; its parent must exist. Outputs:
`evidence.md`, `evidence.csv`, `provenance.json`. Directory mode 0700, files 0600.
No overwriting, uploads or commits. Use a protected local directory; the coordinator
has added the ignored `marketing-private/` root in `.gitignore`. Verify private input/output paths are ignored before placing
them inside a worktree (`git check-ignore PATH`). Never commit observed exports.
Paths below are examples, not supplied evidence. Do not put customer identifiers,
credentials, query text or personal data in source/scope labels or file names.

## Manifest v1

```json
{
  "version": 1,
  "dataClass": "observed",
  "period": {"start": "2026-09-28", "end": "2026-10-04"},
  "inputs": [
    {
      "kind": "daily-v1",
      "source": "approved-daily-export",
      "scope": "personal production UTC approved collection",
      "start": "2026-09-28",
      "end": "2026-10-04",
      "path": "daily.json"
    },
    {
      "kind": "gsc-dates",
      "source": "Search Console",
      "scope": "sc-domain:example.com web all-devices PT no-filters",
      "start": "2026-09-28",
      "end": "2026-10-04",
      "path": "Dates.csv"
    }
  ]
}
```

Inputs must be relative paths confined to the manifest directory (including symlink
resolution). `inputs: []` is valid and yields
no observations, not zero performance. Optional `baseline` has the same start/end
shape, must precede period, and requires its own source rows. Both periods are
exactly seven inclusive dates. Omit baseline when unknown; never invent rows.
`dataClass` must be `observed` or `synthetic`; use separate manifests and never mix
synthetic fixtures into observed evidence. This label is an operator attestation,
not automatic verification of provenance.

Every source needs explicit declared dates and scope. For Search Console, record
property, search type, filters and timezone in scope; if too long, use a stable
scope label mapped to a separate private export log. For first-party data, record
environment, timezone and consent/collection coverage. Changing scope creates a
separate series. Never sum scopes/properties or interpret them as unique users.

### Daily JSON v1

```json
{"version":1,"days":[{"date":"2026-09-28","counts":{"personal_cost_saved":2,"personal_billing_date_saved":1,"personal_renewal_decision_saved":0}}]}
```

**The above is synthetic format illustration, not real statistics.** These are
accepted milestone submission counts (browser first milestone per consent period),
not every save action, money saved, unique users, cohort retention,
funnel steps or conversions. Only the three listed event names are accepted.
The current client emits `personal_cost_saved` only for a validated **Quick Add**
successfully persisted locally; blank Add and ordinary manual Add are not covered.
Billing and renewal milestones require an explicit changed valid value to persist.
See the [runtime contract](../marketing-runtime.md) for exact context exclusions,
consent-period deduplication limits and delivery undercount caveats.
Missing keys become zero **only within existing rows**. Null, booleans, strings,
negative/fractional/unsafe counts, unknown fields, versions and duplicate dates
are rejected. Missing dates stay unknown; seven rows are required for weekly
totals. Upstream retries can still inflate aggregate counts: this toolkit cannot
deduplicate events without an upstream event-level contract.

### Search Console Dates.csv

Manually export the Search results report's daily Dates table in English, with
exact header `Date,Clicks,Impressions,CTR,Position`. Use actual exported files,
not dashboard screenshots, query tables, API JSON or a hand-invented CSV schema.
Dates must be ISO; clicks/impressions nonnegative integers; CTR a percentage
such as `33.33%`; position a nonnegative decimal (at least 1 with impressions).
CTR must agree with counts to its displayed rounding precision. BOM, quoted
fields and CRLF are accepted. Localized headers, comparison columns, thousands
separators and unavailable markers are refused, not silently coerced.
Any invalid row fails the entire run without a partial report; a provider format
change needs explicit adapter review, not manual correction of real statistics.

Public grounding: [Google Performance report](https://support.google.com/webmasters/answer/7576553?hl=en)
documents Dates, clicks, impressions, CTR, average position, export and export
zero substitution for unavailable values. It does not guarantee every locale or
export version's literal header. This adapter supports only the exact stated
English contract and fails closed otherwise; tests are synthetic, not proof of
authenticated property access. Exported zeros can therefore carry provider
limitations. Preserve original export plus scope/filter log privately.

Weekly CTR is total clicks / total impressions, not mean daily CTR. Zero
impressions produces unknown CTR; its delta is percentage points. Daily position
is validated but not synthesized into a weekly average. GSC and first-party
daily dates can use different timezones; they are not joined into a funnel.

**Cloudflare Web Analytics CSV: pending, schema unverified; unsupported.** No
guessed adapter, OAuth flow, API token or paid analytics dependency is provided.

## Validation, deduplication and reproducibility

- Each UTF-8 file (including manifest) at most 1 MiB; 32 inputs, 366 rows/input;
  calendar dates restricted to 2000–2099; unknown fields/enums refused.
- SHA-256 of decoded source text recorded with declared range, source, scope,
  row count and duplicate counts. No absolute input paths in report artifacts.
- Duplicate dates inside a file are errors. Repeated snapshot hashes within
  identical provenance are deduplicated (`duplicateSnapshot` in provenance).
  Reusing the same source/scope hash with different dates is refused. Distinct
  sources may legitimately have identical bytes (e.g. all-zero weeks); they stay
  separate and are never summed. Identical source/scope/date rows across exports are
  counted once; conflicting overlaps fail. For revised exports, explicitly
  select one authoritative snapshot instead of summing them.
- No persistent hidden ledger: every run rebuilds from the supplied manifest.
  Same manifest/source content produces byte-identical artifacts; no clock time
  is injected. Changing bytes changes provenance even if totals do not change.
- Labels are restricted ASCII and cannot begin with spreadsheet formula syntax;
  CSV cells are quoted. Do not use source/scope to carry PII.

## KPIs, interpretation and next actions

Report three weekly accepted milestone submission volumes and GSC clicks/impressions/weighted CTR per
source/scope, coverage days, baseline and absolute change. Completeness is 7/7
dates per period; coverage does not prove the collector was functioning all day.
No percent-lift division by an unknown/zero baseline, significance claims,
forecast, financial savings, customer readiness or attribution is inferred.

Suggested charts: separate daily event series with missing-date gaps; separate
search clicks/impressions series. Do not connect missing observations to zero.
First collect comparable, approved complete weeks, check instrumentation changes
and provider preliminary-data caveats, then investigate descriptive changes.
User activation/retention and causal marketing effectiveness need a separate
privacy-approved denominator/cohort or experiment design, not these aggregates.

See [first readiness report](./evidence-readiness-20261005.md). The test suite is
explicitly synthetic; it exercises parsing, bounds, deduplication, unknown
baselines, aggregation and real standalone CLI artifact creation.
