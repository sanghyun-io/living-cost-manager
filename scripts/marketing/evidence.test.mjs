// All in-memory data and temporary files below are SYNTHETIC TEST FIXTURES.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { daily, searchConsole, build, render, date, EVENTS } from './evidence.mjs';

const period = { start: '2026-09-28', end: '2026-10-04' };
const rows = Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10), counts: { personal_cost_saved: 2 } }));
const raw = days => JSON.stringify({ version: 1, days });
const source = { kind: 'daily-v1', source: 'synthetic-local', scope: 'test UTC', ...period, path: 'daily.json' };
const manifest = inputs => ({ version: 1, dataClass: 'synthetic', period, inputs });
const header = 'Date,Clicks,Impressions,CTR,Position\n';

test('daily valid missing keys zero; absent rows are not synthesized', () => {
  assert.deepEqual(daily(raw([rows[0]]))[0], { date: rows[0].date, personal_cost_saved: 2, personal_billing_date_saved: 0, personal_renewal_decision_saved: 0 });
  assert.equal(daily(raw([])).length, 0);
});
test('daily strict counts and unknown fields', () => {
  for (const value of [null, -1, 0.5, '1', true, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => daily(raw([{ date: rows[0].date, counts: { personal_cost_saved: value } }])));
  for (const data of [{ version: 2, days: [] }, { version: 1, days: [], email: 'x' }, { version: 1, days: [{ ...rows[0], user: 'x' }] }, { version: 1, days: [{ date: rows[0].date, counts: { unknown: 1 } }] }]) assert.throws(() => daily(JSON.stringify(data)));
});
test('date, duplicate, size and row limits', () => {
  for (const d of ['2026-02-29', '2026-13-01', '2026-04-31', '2026-1-01', '2026-01-01T00:00:00Z']) assert.throws(() => date(d));
  assert.equal(date('2024-02-29'), '2024-02-29');
  assert.throws(() => daily(raw([rows[0], rows[0]])), /Duplicate/);
  assert.throws(() => daily(' '.repeat(1048577)), /1 MiB/);
  assert.throws(() => daily(raw(Array(367).fill(rows[0]))), /row limit/);
});
test('GSC actual English header, BOM, CRLF and quoted columns', () => {
  const input = '\uFEFF' + header.replace('\n', '\r\n') + '"2026-09-28","1","3","33.33%","2.5"\r\n';
  assert.deepEqual(searchConsole(input), [{ date: '2026-09-28', clicks: 1, impressions: 3, ctr: 33.33, position: 2.5 }]);
});
test('GSC schema, numbers, duplicate dates and malformed CSV refusal', () => {
  for (const input of [header.replace('Date', '날짜'), header + '2026-09-28,1,3,0.3333,2\n', header + '2026-09-28,4,3,100%,2\n', header + '2026-09-28,1,3,50%,2\n', header + '2026-09-28,1,3,33.33%,0\n', header + '2026-09-28,-1,3,0%,2\n', header + '"2026-09-28,1,3,33%,2', header + '"2026-09-28"x,1,3,33%,2', header + '2026-09-28,0,0,0%,0,extra', header + '2026-09-28,0,0,0%,0\n2026-09-28,0,0,0%,0\n']) assert.throws(() => searchConsole(input));
});
test('weekly sums events; baseline unknown; partial period unknown', () => {
  const full = build(manifest([source]), () => raw(rows));
  assert.equal(full.metrics[0].value, 14); assert.equal(full.metrics[0].baseline, null); assert.equal(full.metrics[0].delta, null);
  assert.equal(full.metrics[1].value, 0);
  assert.equal(build(manifest([source]), () => raw(rows.slice(1))).metrics[0].value, null);
  assert.equal(build(manifest([]), () => '').metrics.length, 0);
});
test('empty readiness manifest emits only unknown evidence, no synthetic statistics', () => {
  const input = JSON.parse(readFileSync(new URL('./empty-week.example.json', import.meta.url), 'utf8'));
  const report = build(input, () => { throw new Error('No source should be read'); });
  const output = render(report);
  assert.equal(report.baseline, null); assert.deepEqual(report.metrics, []); assert.deepEqual(report.provenance, []);
  assert.match(output.markdown, /No observations supplied/);
  assert.match(output.markdown, /unknown \(not supplied\)/);
  assert.equal(output.csv.trim().split('\n').length, 1);
});
test('complete baseline enables descriptive delta including true zero', () => {
  const before = { start: '2026-09-21', end: '2026-09-27' };
  const old = rows.map((r, i) => ({ date: `2026-09-${21 + i}`, counts: {} }));
  const report = build({ ...manifest([source, { ...source, ...before, path: 'before.json' }]), baseline: before }, path => raw(path === 'before.json' ? old : rows));
  assert.equal(report.metrics[0].baseline, 0); assert.equal(report.metrics[0].delta, 14);
});
test('hash and same-source/date dedup; conflict and relabel refusal', () => {
  const report = build(manifest([source, source]), () => raw(rows));
  assert.equal(report.metrics[0].value, 14); assert.equal(report.provenance[1].duplicateRows, 7);
  assert.equal(build(manifest([source, { ...source, source: 'other' }]), () => raw(rows)).metrics.length, 6);
  assert.throws(() => build(manifest([source, { ...source, start: '2026-09-27' }]), () => raw(rows)), /relabeled/);
  assert.throws(() => build(manifest([source, { ...source, path: 'different' }]), p => raw(p === 'different' ? rows.map(r => ({ ...r, counts: {} })) : rows)), /Conflicting/);
  const overlap = build(manifest([source, { ...source, path: 'subset' }]), p => raw(p === 'subset' ? rows.slice(0, 1) : rows));
  assert.equal(overlap.metrics[0].value, 14);
});
test('manifest strict enum, range, scope and bounds', () => {
  for (const m of [{ ...manifest([]), extra: 1 }, { ...manifest([]), dataClass: 'real' }, { ...manifest([]), baseline: null }, { ...manifest([]), period: { start: '2026-09-28', end: '2026-10-03' } }, manifest([{ ...source, kind: 'cf-csv' }]), manifest([{ ...source, scope: '' }]), manifest([{ ...source, scope: '=formula' }]), manifest(Array(33).fill(source))]) assert.throws(() => build(m, () => raw(rows)));
  assert.throws(() => build(manifest([{ ...source, start: '2026-09-29' }]), () => raw(rows)), /outside/);
});
test('safe totals reject overflow', () => {
  assert.throws(() => build(manifest([source]), () => raw(rows.map(r => ({ ...r, counts: { [EVENTS[0]]: Number.MAX_SAFE_INTEGER } })))), /safe integer/);
});
test('GSC weighted CTR not mean of daily CTR; no fabricated position', () => {
  const gsc = header + rows.map((r, i) => `${r.date},${i ? 0 : 1},${i ? 1 : 2},${i ? '0%' : '50%'},1`).join('\n');
  const report = build(manifest([{ ...source, kind: 'gsc-dates' }]), () => gsc);
  assert.equal(report.metrics[2].value, 12.5); assert.equal(report.metrics.length, 3);
});
test('render deterministic, explicit synthetic label and unknowns, provenance hash', () => {
  const report = build(manifest([source]), () => raw(rows));
  assert.deepEqual(render(report), render(build(manifest([source]), () => raw(rows))));
  assert.deepEqual(report.metrics, build(manifest([source]), () => raw([...rows].reverse())).metrics);
});
test('CLI standalone writes private artifacts, refuses overwrite and invalid input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-marketing-evidence-'));
  try {
    writeFileSync(join(dir, 'daily.json'), raw(rows));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest([source])));
    const run = out => spawnSync(process.execPath, ['scripts/marketing/evidence.mjs', '--manifest', join(dir, 'manifest.json'), '--out', join(dir, out)], { encoding: 'utf8' });
    assert.equal(run('out').status, 0); assert.equal(run('again').status, 0);
    assert.equal(statSync(join(dir, 'out')).mode & 0o777, 0o700);
    for (const name of ['evidence.md', 'evidence.csv', 'provenance.json']) {
      assert.equal(readFileSync(join(dir, 'out', name), 'utf8'), readFileSync(join(dir, 'again', name), 'utf8'));
      assert.equal(statSync(join(dir, 'out', name)).mode & 0o777, 0o600);
    }
    assert.match(readFileSync(join(dir, 'out/evidence.md'), 'utf8'), /TEST ONLY/);
    assert.match(readFileSync(join(dir, 'out/evidence.csv'), 'utf8'), /unknown/);
    assert.equal(run('out').status, 1);
    writeFileSync(join(dir, 'daily.json'), raw([rows[0], rows[0]])); assert.equal(run('bad').status, 1);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest([{ ...source, path: join(dir, 'daily.json') }]))); assert.equal(run('absolute').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI malformed JSON errors never echo input tokens or paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-marketing-redaction-'));
  const token = 'SYNTHETIC_PRIVATE_TOKEN_DO_NOT_ECHO';
  const cli = new URL('./evidence.mjs', import.meta.url).pathname;
  try {
    const run = () => spawnSync(process.execPath, [cli, '--manifest', join(dir, 'manifest.json'), '--out', join(dir, 'out')], { encoding: 'utf8' });
    writeFileSync(join(dir, 'manifest.json'), '{"secret":' + token + '}');
    let result = run();
    assert.equal(result.status, 1); assert.match(result.stderr, /Invalid manifest JSON/);
    assert.ok(!result.stderr.includes(token) && !result.stderr.includes(dir));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest([source])));
    writeFileSync(join(dir, 'daily.json'), '{"secret":' + token + '}');
    result = run();
    assert.equal(result.status, 1); assert.match(result.stderr, /Invalid daily JSON/);
    assert.ok(!result.stderr.includes(token) && !result.stderr.includes(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
