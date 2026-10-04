import { test } from "node:test";
import assert from "node:assert/strict";
import { assertVerificationTarget } from "./verification-target.mjs";

test("standalone or development DB URLs cannot reach fixture writes", async () => {
  await assert.rejects(assertVerificationTarget({}), /API_TEST_DATABASE_URL/);
  const env = { ...process.env };
  await assert.rejects(assertVerificationTarget({ ...env, LCM_VERIFY_CLUSTER_MARKER: undefined }), /ownership marker/);
  for (const databaseUrl of [
    "postgresql://lcm_test@127.0.0.1:5432/lcm_test?schema=lcm_test",
    "postgresql://lcm_test@127.0.0.1:5433/lcm_test?schema=lcm_test",
    "postgresql://lcm_test@remote.test:55483/lcm_test?schema=lcm_test",
    "postgresql://lcm_test@127.0.0.1:55483/live?schema=lcm_test",
    "postgresql://lcm_test@127.0.0.1:55483/lcm_test?schema=public"
  ]) await assert.rejects(assertVerificationTarget({ ...env, API_TEST_DATABASE_URL: databaseUrl }));
});
test("only matching purpose-created cluster ownership passes", async () => {
  assert.equal(await assertVerificationTarget(process.env), process.env.API_TEST_DATABASE_URL);
  const wrongPort = new URL(process.env.API_TEST_DATABASE_URL); wrongPort.port = wrongPort.port === "55483" ? "55484" : "55483";
  await assert.rejects(assertVerificationTarget({ ...process.env, API_TEST_DATABASE_URL: wrongPort.href }));
});
