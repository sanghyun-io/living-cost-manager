#!/usr/bin/env node
// Bounded local budget gate for packaging the already-downloaded Pages release.
// Policy constants intentionally have no environment/CLI override.
import { lstatSync, readdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const FLOOR_BYTES = 15 * 1024 ** 3;
export const RESERVE_BYTES = 1 * 1024 ** 3;
export const PEAK_FACTOR_NUMERATOR = 12;
export const PEAK_FACTOR_DENOMINATOR = 10;
export const TAR_ENTRY_OVERHEAD_BYTES = 1024;
const MAX_ENTRIES = 100_000;

export function estimateBudget(rawBytes, availableBytes, entries = 0) {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0 ||
      !Number.isSafeInteger(availableBytes) || availableBytes < 0 ||
      !Number.isSafeInteger(entries) || entries < 0 || entries > MAX_ENTRIES) {
    throw new Error('invalid byte count');
  }
  const peak = (BigInt(rawBytes) * BigInt(PEAK_FACTOR_NUMERATOR) + BigInt(PEAK_FACTOR_DENOMINATOR - 1)) /
    BigInt(PEAK_FACTOR_DENOMINATOR) + BigInt(entries) * BigInt(TAR_ENTRY_OVERHEAD_BYTES);
  const required = BigInt(FLOOR_BYTES) + BigInt(RESERVE_BYTES) + peak;
  if (peak > BigInt(Number.MAX_SAFE_INTEGER) || required > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('required space exceeds safe bound');
  }
  const estimatedPeakBytes = Number(peak);
  const requiredBytes = Number(required);
  return { rawBytes, estimatedPeakBytes, reserveBytes: RESERVE_BYTES,
    floorBytes: FLOOR_BYTES, requiredBytes, availableBytes,
    allowed: availableBytes >= requiredBytes };
}

export function parseAvailableBytes(dfOutput) {
  const lines = dfOutput.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('df output invalid');
  const fields = lines[1].trim().split(/\s+/);
  // macOS /bin/df -kP: filesystem, blocks, used, available, capacity, mount.
  const availableKiB = Number(fields[3]);
  if (!Number.isSafeInteger(availableKiB) || availableKiB < 0) throw new Error('df output invalid');
  const availableBytes = availableKiB * 1024;
  if (!Number.isSafeInteger(availableBytes)) throw new Error('df output invalid');
  return availableBytes;
}

export function measureRegularTree(root) {
  let bytes = 0;
  let entries = 0;
  function visit(path) {
    if (++entries > MAX_ENTRIES) throw new Error('release tree entry bound exceeded');
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error('release tree contains symlink');
    if (st.isFile()) {
      if (!Number.isSafeInteger(st.size) || st.size < 0 || bytes > Number.MAX_SAFE_INTEGER - st.size) {
        throw new Error('release tree size invalid');
      }
      bytes += st.size;
      return;
    }
    if (!st.isDirectory()) throw new Error('release tree contains non-regular entry');
    for (const name of readdirSync(path)) visit(join(path, name));
  }
  visit(root);
  return { bytes, entries };
}

export function checkReleaseBudget(root, dfOutput) {
  const tree = measureRegularTree(root);
  return { ...tree, ...estimateBudget(tree.bytes, parseAvailableBytes(dfOutput), tree.entries) };
}

function main() {
  const workspace = process.env.GITHUB_WORKSPACE;
  const requested = process.argv[2];
  if (!workspace || !requested || process.argv.length !== 3) throw new Error('release path unavailable');
  const expected = resolve(workspace, 'release');
  const actual = resolve(requested);
  const rel = relative(resolve(workspace), actual);
  if (actual !== expected || !rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('release path is not the expected workspace fixture');
  const df = execFileSync('/bin/df', ['-kP', '/Users'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const budget = checkReleaseBudget(actual, df);
  console.log(`ARCHIVE_BUDGET raw_bytes=${budget.rawBytes} entries=${budget.entries} estimated_peak_bytes=${budget.estimatedPeakBytes} reserve_bytes=${budget.reserveBytes} floor_bytes=${budget.floorBytes} required_bytes=${budget.requiredBytes} available_bytes=${budget.availableBytes}`);
  if (!budget.allowed) throw new Error('disk budget blocked');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(`ARCHIVE_BUDGET_BLOCKED ${error.message}`);
    process.exitCode = 1;
  }
}
