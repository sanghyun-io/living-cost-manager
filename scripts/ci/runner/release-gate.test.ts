// Behavioural tests for scripts/ci/release-gate.mjs — the deploy gate that
// must accept ONLY an exact-repo/workflow/event/branch/head-SHA, completed,
// SUCCESS (latest attempt per run) CI run, and must bind the downloaded
// artifact to that run by SHA + runId + runAttempt + content digest.
// Fixture run objects mirror the real REST shape of
// GET /repos/{o}/{r}/actions/runs?event=push&head_sha=… (workflow_runs[]).
import { describe, expect, it, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const GATE = path.join(ROOT, "scripts/ci/release-gate.mjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA_OTHER = "ffffffffffffffffffffffffffffffffffffffff";
const CI_NAME = "CI (Mac Mini self-hosted)";

function runEntry(partial: Record<string, unknown>) {
  return {
    id: 100,
    run_id: 100,
    name: CI_NAME,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: SHA,
    run_attempt: 1,
    ...partial,
  };
}

const tmpBases: string[] = [];
afterAll(() => {
  for (const b of tmpBases) fs.rmSync(b, { recursive: true, force: true });
});

function gateCli(args: string[], stdin?: string) {
  return spawnSync("node", [GATE, ...args], {
    encoding: "utf8",
    input: stdin ?? null,
  });
}

describe("gate subcommand (real CLI, JSON fixtures)", () => {
  const runsFile = (runs: unknown[]) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-gate-"));
    tmpBases.push(base);
    const f = path.join(base, "runs.json");
    fs.writeFileSync(f, JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
    return f;
  };

  it("passes on the single eligible SUCCESS run and emits runId+attempt", () => {
    const f = runsFile([runEntry({})]);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ runId: 100, runAttempt: 1, headSha: SHA });
  });

  it("rejects: wrong workflow name", () => {
    const f = runsFile([runEntry({ name: "Deploy Pages (production)" })]);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no workflow run");
  });

  it("rejects: wrong head_branch (e.g. release/x push of same SHA object)", () => {
    const f = runsFile([runEntry({ head_branch: "release/x" })]);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
    expect(r.status).not.toBe(0);
  });

  it("rejects: wrong event (schedule/workflow_dispatch cannot satisfy the gate)", () => {
    const f = runsFile([runEntry({ event: "workflow_dispatch" })]);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
    expect(r.status).not.toBe(0);
  });

  it("rejects: head_sha different from the deploy target (no stale-run pickup)", () => {
    const f = runsFile([runEntry({ head_sha: SHA_OTHER })]);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
    expect(r.status).not.toBe(0);
  });

  it("rejects: conclusion failure and still-in-progress runs", () => {
    for (const partial of [{ conclusion: "failure" }, { status: "in_progress", conclusion: null }, { status: "completed", conclusion: "cancelled" }]) {
      const f = runsFile([runEntry(partial)]);
      const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
      expect(r.status, JSON.stringify(partial)).not.toBe(0);
      expect(r.stderr).toContain("did not end SUCCESS");
    }
  });

  it("latest attempt wins per run id: fail→rerun-success passes with the SUCCESS attempt", () => {
    const f = runsFile([
      runEntry({ run_attempt: 1, conclusion: "failure" }),
      runEntry({ run_attempt: 2, conclusion: "success" }),
    ]);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).runAttempt).toBe(2);
  });

  it("success→rerun-fail INVALIDATES the older success (no hidden green)", () => {
    const f = runsFile([
      runEntry({ run_attempt: 1, conclusion: "success" }),
      runEntry({ run_attempt: 2, conclusion: "failure" }),
    ]);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("latest attempt");
  });

  it("multiple run ids all-green: selects newest run id", () => {
    const f = runsFile([runEntry({ id: 90, run_id: 90 }), runEntry({ id: 120, run_id: 120 })]);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).runId).toBe(120);
  });

  it("multiple run ids with ANY non-success latest: rejects", () => {
    const f = runsFile([
      runEntry({ id: 90, run_id: 90 }),
      runEntry({ id: 120, run_id: 120, conclusion: "failure" }),
    ]);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", f]);
    expect(r.status).not.toBe(0);
  });

  it("empty runs list rejects; stdin '-' input works", () => {
    const f = runsFile([]);
    expect(gateCli(["gate", "--target-sha", SHA, "--runs", f]).status).not.toBe(0);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", "-"], JSON.stringify({ workflow_runs: [runEntry({})] }));
    expect(r.status, r.stderr).toBe(0);
  });

  it("malformed target sha rejects", () => {
    const f = runsFile([runEntry({})]);
    const r = gateCli(["gate", "--target-sha", "notashortsha", "--runs", f]);
    expect(r.status).not.toBe(0);
  });
});

describe("write + verify subcommands (artifact binding, digest tamper detection)", () => {
  function makeOut(base: string) {
    const out = path.join(base, "out");
    fs.mkdirSync(path.join(out, "assets"), { recursive: true });
    fs.writeFileSync(path.join(out, "index.html"), "<html>lcm</html>");
    fs.writeFileSync(path.join(out, "assets", "app.js"), "console.log(1)");
    fs.writeFileSync(path.join(out, "release-meta.json"), JSON.stringify({ commitSha: SHA }) + "\n");
    return out;
  }

  it("roundtrip: write then verify passes", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art-"));
    tmpBases.push(base);
    const out = makeOut(base);
    const w = gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"), "--sha", SHA, "--run-id", "100", "--attempt", "3"]);
    expect(w.status, w.stderr).toBe(0);
    const v = gateCli(["verify", "--dir", base, "--sha", SHA, "--run-id", "100", "--attempt", "3"]);
    expect(v.status, v.stderr).toBe(0);
    const info = JSON.parse(fs.readFileSync(path.join(base, "build-info.json"), "utf8"));
    expect(info.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(info.repo).toBe("sanghyun-io/living-cost-manager");
  });

  it("verify fails when artifact content is touched after CI", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art2-"));
    tmpBases.push(base);
    const out = makeOut(base);
    gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"), "--sha", SHA, "--run-id", "100", "--attempt", "1"]);
    fs.writeFileSync(path.join(out, "assets", "app.js"), "console.log('tampered')");
    const v = gateCli(["verify", "--dir", base, "--sha", SHA, "--run-id", "100", "--attempt", "1"]);
    expect(v.status).not.toBe(0);
    expect(v.stderr).toContain("digest mismatch");
  });

  it("verify fails on wrong SHA, run id, or attempt", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art3-"));
    tmpBases.push(base);
    const out = makeOut(base);
    gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"), "--sha", SHA, "--run-id", "100", "--attempt", "7"]);
    const variants = [
      ["--sha", SHA_OTHER, "--run-id", "100", "--attempt", "7"],
      ["--sha", SHA, "--run-id", "101", "--attempt", "7"],
      ["--sha", SHA, "--run-id", "100", "--attempt", "1"],
    ];
    for (const args of variants) {
      const v = gateCli(["verify", "--dir", base, ...args]);
      expect(v.status, args.join(" ")).not.toBe(0);
    }
  });

  it("verify fails when build-info identity fields are swapped", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art4-"));
    tmpBases.push(base);
    const out = makeOut(base);
    gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"), "--sha", SHA, "--run-id", "100", "--attempt", "1"]);
    const infoPath = path.join(base, "build-info.json");
    const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    fs.writeFileSync(infoPath, JSON.stringify({ ...info, event: "workflow_dispatch" }));
    expect(gateCli(["verify", "--dir", base, "--sha", SHA, "--run-id", "100", "--attempt", "1"]).status).not.toBe(0);
  });

  it("write rejects malformed sha and missing identity", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art5-"));
    tmpBases.push(base);
    const out = makeOut(base);
    const r = gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"), "--sha", "xyz", "--run-id", "1", "--attempt", "1"]);
    expect(r.status).not.toBe(0);
    const envClean = { ...process.env };
    delete envClean.GITHUB_SHA;
    const r2 = spawnSync("node", [GATE, "write", "--out-dir", out, "--info", path.join(base, "bi.json")], { encoding: "utf8", env: envClean });
    expect(r2.status).not.toBe(0);
  });
});
