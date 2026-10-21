import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FLOOR_BYTES, RESERVE_BYTES, TAR_ENTRY_OVERHEAD_BYTES,
  estimateBudget, measureRegularTree, parseAvailableBytes,
} from './archive-budget.mjs';

test('budget includes 1.2x payload, per-entry tar overhead, reserve and immutable floor', () => {
  const rawBytes = 10_001;
  const entries = 3;
  const estimatedPeak = Math.ceil(rawBytes * 1.2) + entries * TAR_ENTRY_OVERHEAD_BYTES;
  const required = FLOOR_BYTES + RESERVE_BYTES + estimatedPeak;
  assert.deepEqual(estimateBudget(rawBytes, required, entries), {
    rawBytes, estimatedPeakBytes: estimatedPeak, reserveBytes: RESERVE_BYTES,
    floorBytes: FLOOR_BYTES, requiredBytes: required, availableBytes: required,
    allowed: true,
  });
  assert.equal(estimateBudget(rawBytes, required - 1, entries).allowed, false);
  assert.throws(() => estimateBudget(rawBytes, required, -1), /invalid byte count/);
});

test('tree measurement uses actual regular-file sizes and counts tar entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'lcm-budget-test-'));
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'a.bin'), Buffer.alloc(17));
    writeFileSync(join(root, 'nested', 'b.bin'), Buffer.alloc(29));
    assert.deepEqual(measureRegularTree(root), { bytes: 46, entries: 4 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tree measurement fails closed on symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'lcm-budget-test-'));
  try {
    writeFileSync(join(root, 'real'), 'x');
    symlinkSync(join(root, 'real'), join(root, 'link'));
    assert.throws(() => measureRegularTree(root), /contains symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('df parser accepts the real macOS -kP available-block field', () => {
  const output = execFileSync('/bin/df', ['-kP', '/Users'], { encoding: 'utf8' });
  const availableBytes = parseAvailableBytes(output);
  assert.ok(Number.isSafeInteger(availableBytes) && availableBytes > 0);
});
