#!/usr/bin/env node
// Local-only contract. GSC metric/export semantics:
// https://support.google.com/webmasters/answer/7576553?hl=en
// Exact supported English Dates.csv header is validated, not inferred/localized.
import { openSync, closeSync, fstatSync, mkdirSync, writeFileSync, rmSync, readSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const EVENTS = ['personal_cost_saved', 'personal_billing_date_saved', 'personal_renewal_decision_saved'];
const MAX_BYTES = 1048576, MAX_DAYS = 366, MAX_SOURCES = 32;
const fail = message => { throw new Error(message); };
const requireThat = (ok, message) => { if (!ok) fail(message); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function object(value, allowed, required = allowed) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  requireThat(Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)), 'Unknown or missing fields');
}
export function date(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '2000-01-01' && value <= '2099-12-31', 'Invalid date');
  const parsed = new Date(value + 'T00:00:00Z');
  requireThat(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, 'Invalid calendar date');
  return value;
}
function integer(n) { requireThat(Number.isSafeInteger(n) && n >= 0, 'Invalid nonnegative safe integer'); return n; }
function sum(values) { return integer(values.reduce((a, b) => a + b, 0)); }
function label(s) { requireThat(typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._:/?=&%-]{0,199}$/.test(s), 'Invalid source/scope label'); }
function bounded(text) { requireThat(Buffer.byteLength(text) <= MAX_BYTES, 'Input exceeds 1 MiB'); }
function parseJSON(text, message) {
  try { return JSON.parse(text); } catch { fail(message); }
}
export function daily(text) {
  bounded(text);
  const data = parseJSON(text, 'Invalid daily JSON');
  object(data, ['version', 'days']);
  requireThat(data.version === 1 && Array.isArray(data.days) && data.days.length <= MAX_DAYS, 'Invalid daily v1 or row limit');
  const seen = new Set();
  return data.days.map(row => {
    object(row, ['date', 'counts']); date(row.date);
    requireThat(!seen.has(row.date), 'Duplicate date'); seen.add(row.date);
    object(row.counts, EVENTS, []);
    return { date: row.date, ...Object.fromEntries(EVENTS.map(k => [k, integer(Object.hasOwn(row.counts, k) ? row.counts[k] : 0)])) };
  });
}
// Strict RFC4180-style parser: quoted cells, escaped quotes, BOM and CRLF supported.
export function csv(text) {
  bounded(text); text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const rows = []; let row = [], cell = '', state = 'start';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === 'quoted') {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else state = 'closed'; }
      else cell += ch;
    } else if (ch === ',' || ch === '\n') {
      row.push(cell); cell = ''; state = 'start';
      if (ch === '\n') { rows.push(row); row = []; }
    } else if (ch === '"' && state === 'start') state = 'quoted';
    else { requireThat(state !== 'closed' && ch !== '"' && ch !== '\r', 'Malformed CSV'); cell += ch; state = 'plain'; }
  }
  requireThat(state !== 'quoted', 'Unclosed CSV quote');
  if (cell || row.length || state !== 'start') { row.push(cell); rows.push(row); }
  return rows;
}
export function searchConsole(text) {
  const rows = csv(text);
  requireThat(JSON.stringify(rows.shift()) === JSON.stringify(['Date', 'Clicks', 'Impressions', 'CTR', 'Position']), 'Expected English Dates.csv header Date,Clicks,Impressions,CTR,Position');
  requireThat(rows.length <= MAX_DAYS, 'Row limit'); const seen = new Set();
  return rows.map(c => {
    requireThat(c.length === 5, 'CSV column count'); date(c[0]);
    requireThat(!seen.has(c[0]), 'Duplicate date'); seen.add(c[0]);
    requireThat(/^\d+$/.test(c[1]) && /^\d+$/.test(c[2]) && /^\d+(\.\d+)?%$/.test(c[3]) && /^\d+(\.\d+)?$/.test(c[4]), 'Invalid GSC numeric fields');
    const clicks = integer(Number(c[1])), impressions = integer(Number(c[2]));
    const ctr = Number(c[3].slice(0, -1)), position = Number(c[4]);
    requireThat(clicks <= impressions && ctr <= 100 && Number.isFinite(position) && position <= Number.MAX_SAFE_INTEGER && (impressions === 0 || position >= 1), 'Invalid GSC values');
    const precision = c[3].split('.')[1]?.length - 1 || 0;
    requireThat(Math.abs(ctr - (impressions ? clicks / impressions * 100 : 0)) <= 0.5 * 10 ** -precision + 1e-9, 'CTR inconsistent with clicks/impressions');
    return { date: c[0], clicks, impressions, ctr, position };
  });
}
function range(r) { object(r, ['start', 'end']); date(r.start); date(r.end); requireThat((Date.parse(r.end) - Date.parse(r.start)) / 86400000 === 6, 'Period must be seven inclusive dates'); }
function readBounded(path) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd); requireThat(stat.isFile() && stat.size <= MAX_BYTES, 'Input must be a regular file <= 1 MiB');
    // Bounded read even if a file grows after stat.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const text = readFileBounded(fd, buffer);
    return text;
  } finally { closeSync(fd); }
}
function readFileBounded(fd, buffer) {
  let size = 0, n;
  while (size < buffer.length && (n = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
  requireThat(size <= MAX_BYTES, 'Input exceeds 1 MiB');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
}
export function build(manifest, load) {
  object(manifest, ['version', 'dataClass', 'period', 'baseline', 'inputs'], ['version', 'dataClass', 'period', 'inputs']);
  requireThat(manifest.version === 1 && ['observed', 'synthetic'].includes(manifest.dataClass), 'Invalid manifest version/dataClass');
  range(manifest.period);
  if (manifest.baseline) { range(manifest.baseline); requireThat(manifest.baseline.end < manifest.period.start, 'Baseline must precede period'); }
  else requireThat(!Object.hasOwn(manifest, 'baseline'), 'Omit unknown baseline');
  requireThat(Array.isArray(manifest.inputs) && manifest.inputs.length <= MAX_SOURCES, 'Input limit');
  const groups = new Map(), hashes = new Map(), provenance = [];
  for (const input of manifest.inputs) {
    object(input, ['kind', 'source', 'scope', 'start', 'end', 'path']);
    requireThat(['daily-v1', 'gsc-dates'].includes(input.kind), 'Unsupported kind (Cloudflare schema pending/unverified)');
    label(input.source); label(input.scope); date(input.start); date(input.end);
    requireThat(input.start <= input.end && typeof input.path === 'string' && input.path.length > 0 && input.path.length <= 4096, 'Invalid input range/path');
    const text = load(input.path); bounded(text);
    const hash = createHash('sha256').update(text).digest('hex');
    const key = JSON.stringify([input.kind, input.source, input.scope]);
    const snapshotKey = JSON.stringify([key, hash]);
    const hashKey = JSON.stringify([input.start, input.end]);
    if (hashes.has(snapshotKey)) requireThat(hashes.get(snapshotKey) === hashKey, 'Same source snapshot hash relabeled with different dates');
    const rows = input.kind === 'daily-v1' ? daily(text) : searchConsole(text);
    requireThat(rows.every(r => r.date >= input.start && r.date <= input.end), 'Row outside declared source range');
    const group = groups.get(key) ?? { ...input, rows: new Map() }; groups.set(key, group);
    let duplicates = 0;
    for (const row of rows) {
      const previous = group.rows.get(row.date);
      if (previous) { requireThat(JSON.stringify(previous) === JSON.stringify(row), 'Conflicting source/date snapshot; select one export, do not sum'); duplicates++; }
      else group.rows.set(row.date, row);
    }
    provenance.push({ kind: input.kind, source: input.source, scope: input.scope, start: input.start, end: input.end, sha256: hash, rows: rows.length, duplicateRows: duplicates, duplicateSnapshot: hashes.has(snapshotKey) });
    hashes.set(snapshotKey, hashKey);
  }
  const metrics = [];
  for (const [, g] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const select = r => r ? [...g.rows.values()].filter(d => d.date >= r.start && d.date <= r.end).sort((a, b) => compare(a.date, b.date)) : [];
    const current = select(manifest.period), baseline = select(manifest.baseline);
    const keys = g.kind === 'daily-v1' ? EVENTS : ['clicks', 'impressions', 'ctr_percent'];
    const total = (rows, k) => {
      if (rows.length !== 7) return null;
      if (k === 'ctr_percent') { const n = sum(rows.map(r => r.impressions)); return n ? sum(rows.map(r => r.clicks)) / n * 100 : null; }
      return sum(rows.map(r => r[k]));
    };
    for (const metric of keys) {
      const value = total(current, metric), before = total(baseline, metric);
      metrics.push({ kind: g.kind, source: g.source, scope: g.scope, metric, currentDays: current.length, baselineDays: baseline.length, value, baseline: before, delta: value !== null && before !== null ? value - before : null });
    }
  }
  provenance.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return { version: 1, dataClass: manifest.dataClass, period: manifest.period, baseline: manifest.baseline ?? null, provenance, metrics };
}
const show = n => n === null ? 'unknown' : Number.isInteger(n) ? String(n) : n.toFixed(6);
const quote = s => '"' + String(s).replaceAll('"', '""') + '"';
export function render(report) {
  const p = report.period, b = report.baseline;
  const lines = ['# Private weekly marketing evidence', '', `Data class: **${report.dataClass}**${report.dataClass === 'synthetic' ? ' — TEST ONLY; not real statistics' : ' — supplied local exports; provenance is operator-declared, not independently authenticated'}`, `Period: ${p.start} — ${p.end} (inclusive)`, `Baseline: ${b ? `${b.start} — ${b.end}` : 'unknown (not supplied)'}`, '', 'Counts are events, not users, cohorts, funnels, conversion, revenue or money saved.', 'A missing key is zero only in an existing daily row. Missing dates make weekly totals unknown. No source/scope groups are combined.', 'GSC CTR = sum(clicks) / sum(impressions); delta is percentage points. Zero impressions means unknown CTR. Position remains in the source export; no weekly average is invented.', 'Cloudflare Web Analytics CSV: pending — unverified schema; not imported.', '', '| Source / scope | Metric | Days current / baseline | Current | Baseline | Delta |', '|---|---|---|---|---|---|'];
  for (const r of report.metrics) lines.push(`| ${r.source} / ${r.scope} | ${r.metric} | ${r.currentDays}/7 / ${r.baselineDays}/7 | ${show(r.value)} | ${show(r.baseline)} | ${show(r.delta)} |`);
  if (!report.metrics.length) lines.push('', 'No observations supplied. All marketing performance and baseline outcomes remain unknown.');
  lines.push('', '## Provenance', '', '| Kind | Source | Scope | Declared dates | SHA-256 | Rows / deduplicated |', '|---|---|---|---|---|---|');
  for (const s of report.provenance) lines.push(`| ${s.kind} | ${s.source} | ${s.scope} | ${s.start} — ${s.end} | ${s.sha256} | ${s.rows} / ${s.duplicateRows} |`);
  lines.push('', '## Interpretation and next action', '', '- Daily-v1 counts represent accepted milestone submissions: browser first milestone per consent period, not every action or unique people. Consent reset, multiple browsers and retries can change counts.', '- Compare only complete seven-day windows with unchanged collection, timezone, filters and scope. Differences are descriptive, not causal or statistically significant.', '- Verify source timezone, export filters and collection coverage. Snapshot deduplication cannot deduplicate event retries within an upstream aggregate. Research participant consent is separate from implementation authorization.', '- Proposed chart: daily accepted milestone submissions in separate panels with gaps for missing dates; search clicks/impressions separately. Do not draw a conversion funnel.', '- Obtain a comparable baseline before evaluating trends. No forecast or customer-value claim is supported by this report alone.', '');
  const header = ['data_class', 'period_start', 'period_end', 'baseline_start', 'baseline_end', 'kind', 'source', 'scope', 'metric', 'current_days', 'baseline_days', 'current', 'baseline', 'delta'];
  const rows = report.metrics.map(r => [report.dataClass, p.start, p.end, b?.start ?? 'unknown', b?.end ?? 'unknown', r.kind, r.source, r.scope, r.metric, r.currentDays, r.baselineDays, show(r.value), show(r.baseline), show(r.delta)]);
  return { markdown: lines.join('\n'), csv: [header, ...rows].map(r => r.map(quote).join(',')).join('\n') + '\n' };
}
export function main(args) {
  requireThat(args.length === 4 && args[0] === '--manifest' && args[2] === '--out', 'Usage: node scripts/marketing/evidence.mjs --manifest PRIVATE/manifest.json --out PRIVATE/new-report-directory');
  const path = resolve(args[1]), out = resolve(args[3]);
  const manifest = parseJSON(readBounded(path), 'Invalid manifest JSON');
  const base = realpathSync(dirname(path));
  const report = build(manifest, p => {
    requireThat(!isAbsolute(p), 'Input path must be relative to manifest directory');
    const target = realpathSync(resolve(base, p)), rel = relative(base, target);
    requireThat(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'Input path escapes manifest directory');
    return readBounded(target);
  });
  const rendered = render(report);
  mkdirSync(out, { mode: 0o700 }); // Refuse existing output; never overwrite evidence.
  try {
    for (const [name, content] of [['evidence.md', rendered.markdown], ['evidence.csv', rendered.csv], ['provenance.json', JSON.stringify(report, null, 2) + '\n']]) writeFileSync(resolve(out, name), content, { mode: 0o600, flag: 'wx' });
  } catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
  console.log('Created evidence.md, evidence.csv, provenance.json (private; do not commit).');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`Evidence refused: ${error.code ?? error.message}`); process.exitCode = 1; }
}
