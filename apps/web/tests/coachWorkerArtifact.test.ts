import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { expect, it } from "vitest";
import { COACH_WORKER_URL, COACH_WORKER_HASH, COACH_WORKER_BYTES } from "../app/lib/coachEngine/workerManifest.generated";

it("build-time URL points to the emitted, self-contained, hash-matched JavaScript worker", () => {
  expect(COACH_WORKER_URL).toMatch(/^\/_coachWorker\.[a-f0-9]{16}\.js$/);
  const bytes = readFileSync(new URL("../public" + COACH_WORKER_URL, import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL("../public/_coachWorker.manifest.json", import.meta.url), "utf8"));
  expect(bytes.byteLength).toBe(COACH_WORKER_BYTES);
  expect(createHash("sha256").update(bytes).digest("hex").slice(0, 16)).toBe(COACH_WORKER_HASH);
  expect(manifest).toEqual({ file: COACH_WORKER_URL.slice(1), hash: COACH_WORKER_HASH, bytes: COACH_WORKER_BYTES });
  // Syntax-check as a classic script: raw TS or bare ESM imports cannot pass.
  expect(() => new Script(bytes.toString("utf8"))).not.toThrow();
});
