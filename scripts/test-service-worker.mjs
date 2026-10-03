import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

function harness(fetchImpl, cached) {
  const handlers = {};
  const writes = [];
  vm.runInNewContext(readFileSync("apps/web/public/sw.js", "utf8"), {
    self: { location: { origin: "https://example.test" },
      addEventListener: (name, handler) => { handlers[name] = handler; } },
    URL, Response, fetch: fetchImpl,
    caches: { open: async () => ({ put: async (...args) => writes.push(args) }),
      match: async (request) => request === "./" ? new Response("dashboard") : cached }
  });
  return { writes, request(path, mode = "cors") {
    let response;
    handlers.fetch({ request: { url: `https://example.test${path}`, method: "GET", mode },
      respondWith: (value) => { response = value; } });
    return response;
  } };
}

test("HTTP errors are not cached", async () => {
  const h = harness(async () => new Response("missing", { status: 404 }));
  assert.equal((await h.request("/missing.js")).status, 404);
  assert.equal(h.writes.length, 0);
});
test("offline HTML fallback is navigation-only", async () => {
  const h = harness(async () => { throw Error("offline"); });
  assert.equal((await h.request("/missing.js")).type, "error");
  assert.equal(await (await h.request("/", "navigate")).text(), "dashboard");
});
test("release identity never comes from offline cache", async () => {
  const h = harness(async (_request, options) => {
    assert.equal(options.cache, "no-store"); throw Error("offline");
  }, new Response("stale identity"));
  await assert.rejects(h.request("/release-meta.json"), /offline/);
});
