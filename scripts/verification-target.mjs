import assert from "node:assert/strict";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";

// The test names alone are insufficient: require the exact cluster created by
// verify-usability, with matching URLs and an initialized private data directory.
export async function assertVerificationTarget(env) {
  assert.ok(env.API_TEST_DATABASE_URL, "Run pnpm verify:usability: API_TEST_DATABASE_URL is required");
  assert.ok(env.LCM_VERIFY_CLUSTER_MARKER, "Run pnpm verify:usability: temporary cluster ownership marker is required");
  const target = new URL(env.API_TEST_DATABASE_URL);
  assert.ok(["postgresql:", "postgres:"].includes(target.protocol));
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.pathname, "/lcm_test");
  assert.equal(target.searchParams.get("schema"), "lcm_test");
  assert.ok(Number(target.port) > 0 && !["5432", "5433"].includes(target.port), "Refusing standard development database ports");
  const markerPath = await realpath(env.LCM_VERIFY_CLUSTER_MARKER);
  assert.equal(path.basename(markerPath), "ownership.json");
  assert.match(path.basename(path.dirname(markerPath)), /^lcm-usability-test-[A-Za-z0-9]+$/);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.databaseUrl, env.API_TEST_DATABASE_URL);
  assert.equal(marker.apiOrigin, env.LCM_E2E_API);
  assert.equal(marker.webOrigin, env.LCM_E2E_ORIGIN);
  for (const origin of [marker.apiOrigin, marker.webOrigin]) assert.equal(new URL(origin).hostname, "127.0.0.1");
  assert.match(await readFile(path.join(path.dirname(markerPath), "data/PG_VERSION"), "utf8"), /^\d+/);
  return env.API_TEST_DATABASE_URL;
}
