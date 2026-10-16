// Behavioural tests for scripts/ci/release-gate.mjs — the deploy gate that
// must accept ONLY a run of the ACTUAL ci.yml workflow (numeric workflow_id
// equal to the metadata fetched from the fixed path route, meta.path equal
// to ".github/workflows/ci.yml", both enforced inside the validator), for
// event push on branch main at the exact head SHA, completed SUCCESS (latest
// attempt per run), and must bind the downloaded artifact to that run by
// SHA + runId + runAttempt + content digest.
// Fixture run objects mirror the real REST shape of
// GET /repos/{o}/{r}/actions/workflows/{id}/runs (workflow_runs[]).
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
const CI_PATH = ".github/workflows/ci.yml";
const WF_ID = 777;

const META = { id: WF_ID, name: CI_NAME, path: CI_PATH, state: "active" };

function runEntry(partial: Record<string, unknown> = {}) {
  return {
    id: 100,
    run_id: 100,
    workflow_id: WF_ID,
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
  return spawnSync("node", [GATE, ...args], { encoding: "utf8", input: stdin ?? null });
}

function files(runs: unknown[], meta: unknown) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-gate-"));
  tmpBases.push(base);
  const rf = path.join(base, "runs.json");
  fs.writeFileSync(rf, JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
  let mf = "";
  if (meta !== undefined) {
    mf = path.join(base, "meta.json");
    fs.writeFileSync(mf, typeof meta === "string" ? meta : JSON.stringify(meta));
  }
  return { rf, mf, base };
}

function gate(runs: unknown[], meta: unknown = META, sha = SHA) {
  const { rf, mf } = files(runs, meta);
  return gateCli(["gate", "--target-sha", sha, "--runs", rf, "--workflow-meta", mf]);
}

describe("gate subcommand — run identity binding", () => {
  it("passes on the single eligible SUCCESS run of ci.yml and emits runId+attempt+workflowId", () => {
    const r = gate([runEntry()]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ runId: 100, runAttempt: 1, headSha: SHA, workflowId: WF_ID });
  });

  it("REPRO(review): a SUCCESS run of a DIFFERENT workflow file (not-ci.yml) with the SAME display name is rejected", () => {
    // runs[] scoped globally could include this; scoped queries plus the
    // workflow_id equality check both must refuse it.
    const r = gate([runEntry({ workflow_id: 999 })]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no workflow run");
  });

  it("run entry without workflow_id is rejected (no lenient fallback)", () => {
    const e = runEntry();
    delete (e as Record<string, unknown>).workflow_id;
    const r = gate([e]);
    expect(r.status).not.toBe(0);
  });

  it("meta from a different path is rejected even if the run looks right", () => {
    const r = gate([runEntry()], { id: WF_ID, name: CI_NAME, path: ".github/workflows/other.yml" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("path");
  });

  it("meta with missing/non-numeric id is rejected; missing --workflow-meta is fatal", () => {
    expect(gate([runEntry()], { path: CI_PATH }).status).not.toBe(0);
    expect(gate([runEntry()], { id: "777", path: CI_PATH }).status).not.toBe(0);
    const { rf } = files([runEntry()], undefined);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", rf]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--workflow-meta");
  });

  it("malformed meta JSON fails closed", () => {
    const r = gate([runEntry()], "{not json");
    expect(r.status).not.toBe(0);
  });

  it("rejects: wrong display name, wrong branch, wrong event, wrong sha, in-progress/failure/cancelled", () => {
    for (const partial of [
      { name: "Other" },
      { head_branch: "release/x" },
      { event: "workflow_dispatch" },
      { head_sha: SHA_OTHER },
      { conclusion: "failure" },
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "cancelled" },
    ]) {
      const r = gate([runEntry(partial)]);
      expect(r.status, JSON.stringify(partial)).not.toBe(0);
    }
  });

  it("latest attempt wins per run id: fail→rerun-success passes with the SUCCESS attempt", () => {
    const r = gate([
      runEntry({ run_attempt: 1, conclusion: "failure" }),
      runEntry({ run_attempt: 2, conclusion: "success" }),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).runAttempt).toBe(2);
  });

  it("success→rerun-fail INVALIDATES the older success (no hidden green)", () => {
    const r = gate([
      runEntry({ run_attempt: 1, conclusion: "success" }),
      runEntry({ run_attempt: 2, conclusion: "failure" }),
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("latest attempt");
  });

  it("multiple run ids all-green: selects newest; ANY non-success latest rejects", () => {
    const ok = gate([runEntry({ id: 90, run_id: 90 }), runEntry({ id: 120, run_id: 120 })]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).runId).toBe(120);
    const bad = gate([runEntry({ id: 90, run_id: 90 }), runEntry({ id: 120, run_id: 120, conclusion: "failure" })]);
    expect(bad.status).not.toBe(0);
  });

  it("empty runs list rejects; a mixed pool with one eligible ci.yml run selects it", () => {
    expect(gate([]).status).not.toBe(0);
    const r = gate([
      runEntry({ workflow_id: 999, id: 55, run_id: 55 }), // spoofed same-name other file
      runEntry({}),                                       // eligible
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).runId).toBe(100);
  });

  it("stdin '-' runs input works; malformed target sha rejects", () => {
    const { mf } = files([runEntry()], META);
    const r = gateCli(["gate", "--target-sha", SHA, "--runs", "-", "--workflow-meta", mf],
      JSON.stringify({ workflow_runs: [runEntry()] }));
    expect(r.status, r.stderr).toBe(0);
    const { rf } = files([runEntry()], META);
    expect(gateCli(["gate", "--target-sha", "notashortsha", "--runs", rf, "--workflow-meta", mf]).status).not.toBe(0);
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

  function writeAndVerify(extra: string[] = [], verifyArgs?: string[]) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art-"));
    tmpBases.push(base);
    const out = makeOut(base);
    const w = gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"),
      "--sha", SHA, "--run-id", "100", "--attempt", "3", "--workflow-path", CI_PATH, ...extra]);
    const { mf } = files([], META);
    const v = gateCli(["verify", "--dir", base, "--sha", SHA, "--run-id", "100", "--attempt", "3",
      "--workflow-meta", mf, ...(verifyArgs ?? [])]);
    return { base, out, w, v };
  }

  it("roundtrip: write then verify passes; build-info records path + identity", () => {
    const { base, w, v } = writeAndVerify();
    expect(w.status, w.stderr).toBe(0);
    expect(v.status, v.stderr).toBe(0);
    const info = JSON.parse(fs.readFileSync(path.join(base, "build-info.json"), "utf8"));
    expect(info.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(info.repo).toBe("sanghyun-io/living-cost-manager");
    expect(info.workflowPath).toBe(CI_PATH);
    expect(info.workflowId).toBe(null); // CI step cannot always know the numeric id; gate enforces it
    const withId = writeAndVerify(["--workflow-id", "777"]);
    expect(withId.v.status, withId.v.stderr).toBe(0);
  });

  it("write rejects a wrong --workflow-path and missing path", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art-wp-"));
    tmpBases.push(base);
    const out = makeOut(base);
    const bad = gateCli(["write", "--out-dir", out, "--info", path.join(base, "bi.json"),
      "--sha", SHA, "--run-id", "1", "--attempt", "1", "--workflow-path", ".github/workflows/not-ci.yml"]);
    expect(bad.status).not.toBe(0);
    const missing = gateCli(["write", "--out-dir", out, "--info", path.join(base, "bi2.json"),
      "--sha", SHA, "--run-id", "1", "--attempt", "1"]);
    expect(missing.status).not.toBe(0);
  });

  it("verify fails on workflow-id mismatch when build-info recorded one", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art-wid-"));
    tmpBases.push(base);
    const out = makeOut(base);
    const w = gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"),
      "--sha", SHA, "--run-id", "100", "--attempt", "3", "--workflow-path", CI_PATH, "--workflow-id", "777"]);
    expect(w.status, w.stderr).toBe(0);
    const { mf } = files([], { id: 999, path: CI_PATH });
    const v = gateCli(["verify", "--dir", base, "--sha", SHA, "--run-id", "100", "--attempt", "3", "--workflow-meta", mf]);
    expect(v.status).not.toBe(0);
    expect(v.stderr).toContain("workflowId");
  });

  it("verify fails when artifact content is touched after CI", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art2-"));
    tmpBases.push(base);
    const out = makeOut(base);
    gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"),
      "--sha", SHA, "--run-id", "100", "--attempt", "1", "--workflow-path", CI_PATH]);
    fs.writeFileSync(path.join(out, "assets", "app.js"), "console.log('tampered')");
    const { mf } = files([], META);
    const v = gateCli(["verify", "--dir", base, "--sha", SHA, "--run-id", "100", "--attempt", "1", "--workflow-meta", mf]);
    expect(v.status).not.toBe(0);
    expect(v.stderr).toContain("digest mismatch");
  });

  it("verify fails on wrong SHA, run id, or attempt", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art3-"));
    tmpBases.push(base);
    const out = makeOut(base);
    gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"),
      "--sha", SHA, "--run-id", "100", "--attempt", "7", "--workflow-path", CI_PATH]);
    const { mf } = files([], META);
    const variants = [
      ["--sha", SHA_OTHER, "--run-id", "100", "--attempt", "7"],
      ["--sha", SHA, "--run-id", "101", "--attempt", "7"],
      ["--sha", SHA, "--run-id", "100", "--attempt", "1"],
    ];
    for (const args of variants) {
      const v = gateCli(["verify", "--dir", base, ...args, "--workflow-meta", mf]);
      expect(v.status, args.join(" ")).not.toBe(0);
    }
  });

  it("verify fails when build-info identity fields are swapped, and without meta", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art4-"));
    tmpBases.push(base);
    const out = makeOut(base);
    gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"),
      "--sha", SHA, "--run-id", "100", "--attempt", "1", "--workflow-path", CI_PATH]);
    const infoPath = path.join(base, "build-info.json");
    const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    fs.writeFileSync(infoPath, JSON.stringify({ ...info, event: "schedule" }));
    const { mf } = files([], META);
    expect(gateCli(["verify", "--dir", base, "--sha", SHA, "--run-id", "100", "--attempt", "1", "--workflow-meta", mf]).status).not.toBe(0);
    // swap workflowPath too
    fs.writeFileSync(infoPath, JSON.stringify({ ...info, workflowPath: ".github/workflows/evil.yml" }));
    expect(gateCli(["verify", "--dir", base, "--sha", SHA, "--run-id", "100", "--attempt", "1", "--workflow-meta", mf]).status).not.toBe(0);
    // missing meta entirely
    expect(gateCli(["verify", "--dir", base, "--sha", SHA, "--run-id", "100", "--attempt", "1"]).status).not.toBe(0);
  });

  it("write rejects malformed sha and missing identity", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-art5-"));
    tmpBases.push(base);
    const out = makeOut(base);
    const r = gateCli(["write", "--out-dir", out, "--info", path.join(base, "build-info.json"),
      "--sha", "xyz", "--run-id", "1", "--attempt", "1", "--workflow-path", CI_PATH]);
    expect(r.status).not.toBe(0);
    const envClean = { ...process.env };
    delete envClean.GITHUB_SHA;
    const r2 = spawnSync("node", [GATE, "write", "--out-dir", out, "--info", path.join(base, "bi.json"), "--workflow-path", CI_PATH], { encoding: "utf8", env: envClean });
    expect(r2.status).not.toBe(0);
  });
});
