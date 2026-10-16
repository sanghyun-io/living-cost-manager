// Behavioural security tests for the LCM CI runner kit (official appRoot
// architecture). These run the REAL bash logic of the kit against fixture
// trees under a temp dir as the normal dev user — no root, no accounts,
// no network, no GitHub registration. Structural assertions are used only
// where the file content itself is the specification (workflows/plist).
//
// Architecture under test (see docs/ci-self-hosted-runner-20261016.md):
//   PARENT root-owned 0755 immutable public files + LEAF = official runner
//   appRoot (CI-owned 0700), rename-installed fresh-install-only under the
//   root parent; root never traverses the leaf afterwards; tokens via stdin
//   pipes into root-owned CI-uid scripts, never argv; logs root-owned 0700
//   dir + 0640 pre-created files with NO ACLs (launchd passes fds).
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const KIT = path.join(ROOT, "scripts/ci/runner");

const TEST_NAME = "lcm-prod-macmini-01";
const GOOD_TOKEN = "a".repeat(64); // shape-valid opaque token (fake)

function tmpBase(): string {
  // /var is a symlink on macOS — resolve it so path-component symlink
  // rejection (a real security check) isn't tripped by the fixture host.
  return fs.mkdtempSync(path.join(realpathSync(os.tmpdir()), "lcm-ci-kit-"));
}

function bash(script: string, env: Record<string, string> = {}, cwd?: string) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    cwd: cwd ?? ROOT,
    env: { ...process.env, ...env },
  });
}

function makeFixture(opts: { configStub?: string; runnerStub?: boolean } = {}) {
  const base = tmpBase();
  const gw = path.join(base, "GamjaWorld", "CI");
  const parent = path.join(gw, "lcm-production");
  const leaf = path.join(parent, "app");
  const logDir = path.join(base, "varlog", "lcm-production");
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(leaf, { recursive: true });
  fs.chmodSync(leaf, 0o700);

  // Copy the real rootctl scripts + lib + env into the fixture parent
  // (production puts them there root-owned; fixtures run as the current user).
  for (const [src, dst] of [
    ["rootctl/register.sh", "register.sh"],
    ["rootctl/deregister.sh", "deregister.sh"],
    ["rootctl/runner-status.sh", "runner-status.sh"],
    ["rootctl/run-runner.sh", "run-runner.sh"],
    ["lib/lib-runner.sh", "lib.sh"],
  ]) {
    fs.copyFileSync(path.join(KIT, src), path.join(parent, dst));
    fs.chmodSync(path.join(parent, dst), 0o755);
  }
  fs.writeFileSync(
    path.join(parent, "runner-config.env"),
    [
      `LCM_CI_ACCOUNT=${os.userInfo().username}`,
      `LCM_CI_RUNNER_NAME=${TEST_NAME}`,
      `LCM_CI_REPO_URL=https://github.com/sanghyun-io/living-cost-manager`,
      `LCM_CI_REPO_API=repos/sanghyun-io/living-cost-manager`,
      `LCM_CI_RUNNER_LABELS=self-hosted,macOS,ARM64,lcm-production`,
      `LCM_CI_GAMJAWORLD_DIR=${path.join(base, "GamjaWorld")}`,
      `LCM_CI_CI_BASE=${gw}`,
      `LCM_CI_PARENT=${parent}`,
      `LCM_CI_APP_ROOT=${leaf}`,
      `LCM_CI_LOG_DIR=${logDir}`,
      `LCM_CI_HOME=${path.join(base, "home")}`,
      `LCM_CI_LAUNCHD_LABEL=com.gamjaworld.lcm-ci-actions-runner`,
    ].join("\n") + "\n"
  );
  fs.chmodSync(path.join(parent, "runner-config.env"), 0o644);

  // Official entrypoints inside the leaf (stubs stand in for the real
  // package; the real package is exercised by the dry-run installer test).
  fs.mkdirSync(path.join(leaf, "bin"), { recursive: true });
  const configStub =
    opts.configStub ??
    `#!/bin/bash\nexit 0\n`;
  fs.writeFileSync(path.join(leaf, "config.sh"), configStub);
  fs.chmodSync(path.join(leaf, "config.sh"), 0o755);
  fs.writeFileSync(
    path.join(leaf, "run.sh"),
    `#!/bin/bash\necho "RUNSH argv=$* trap=\${RUNNER_MANUALLY_TRAP_SIG:-unset}" > "$(dirname "$0")/runsh-marker"\nexit 0\n`
  );
  fs.chmodSync(path.join(leaf, "run.sh"), 0o755);
  fs.writeFileSync(
    path.join(leaf, "bin/Runner.Listener"),
    opts.runnerStub === false ? "" : `#!/bin/bash\nexit 0\n`
  );
  fs.chmodSync(path.join(leaf, "bin/Runner.Listener"), 0o755);
  return { base, gw, parent, leaf, logDir };
}

function cleanup(base: string) {
  fs.rmSync(base, { recursive: true, force: true });
}

const FIXTURES: string[] = [];
afterAll(() => {
  for (const b of FIXTURES) cleanup(b);
});

// ---------------------------------------------------------------------------
describe("lib/lib-runner.sh validation helpers (executed for real)", () => {
  const src = `source "${KIT}/lib/lib-runner.sh"`;

  it("rejects any symlink component in a path, accepts plain paths", () => {
    const base = tmpBase();
    FIXTURES.push(base);
    const real = path.join(base, "real");
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(base, "link");
    fs.symlinkSync(real, link);
    const r = bash(`${src}; reject_symlink_components "${real}" && echo CLEAN; reject_symlink_components "${link}" && echo CLEAN || echo SYM`);
    expect(r.stdout).toContain(`CLEAN`);
    expect(r.stdout).toContain(`SYM`);
    // relative and empty paths are rejected too
    const r2 = bash(`${src}; reject_symlink_components "relative/path" && echo OK || echo REJECT; reject_symlink_components "" && echo OK || echo REJECT`);
    expect(r2.stdout).toBe("REJECT\nREJECT\n");
  });

  it("owner/mode/no-write checks behave", () => {
    const base = tmpBase();
    FIXTURES.push(base);
    const dir = path.join(base, "d");
    fs.mkdirSync(dir);
    const uid = String(fs.statSync(dir).uid);
    fs.chmodSync(dir, 0o755);
    expect(bash(`${src}; expect_dir_mode "${dir}" 755 && echo Y || echo N`).stdout).toContain("Y");
    fs.chmodSync(dir, 0o700);
    expect(bash(`${src}; expect_dir_mode "${dir}" 700 && echo Y || echo N`).stdout).toContain("Y");
    expect(bash(`${src}; expect_dir_mode "${dir}" 755 && echo Y || echo N`).stdout).toContain("N");
    expect(bash(`${src}; expect_dir_owner_uid "${dir}" ${uid} && echo Y || echo N`).stdout).toContain("Y");
    expect(bash(`${src}; expect_dir_owner_uid "${dir}" 999999 && echo Y || echo N`).stdout).toContain("N");
    fs.chmodSync(dir, 0o777);
    expect(bash(`${src}; expect_dir_no_group_world_write "${dir}" && echo Y || echo N`).stdout).toContain("N");
    fs.chmodSync(dir, 0o755);
    expect(bash(`${src}; expect_dir_no_group_world_write "${dir}" && echo Y || echo N`).stdout).toContain("Y");
  });

  it("token shape validation accepts sane tokens and rejects corruption", () => {
    const cases: Array<[string, boolean]> = [
      [GOOD_TOKEN, true],
      ["A".repeat(20), true],
      ["x".repeat(255), true],
      ["", false],
      ["short-token", false], // <20 chars
      ["y".repeat(300), false],
      ["token with space", false],
      ["token\rCRLF", false],
      ["token\nnewline", false],
      ["tab\there", false],
      ["unicode".repeat(5) + "✕", false],
    ];
    for (const [tok, want] of cases) {
      const r2 = bash(`${src}; valid_token_shape "$TK" && echo Y || echo N`, { TK: tok });
      expect(r2.stdout.trim(), `token=${JSON.stringify(tok)}`).toBe(want ? "Y" : "N");
    }
  });

  it("expect_no_acl detects real ACL entries", () => {
    const base = tmpBase();
    FIXTURES.push(base);
    const plain = path.join(base, "plain.txt");
    fs.writeFileSync(plain, "x");
    fs.chmodSync(plain, 0o640);
    // fresh macOS files carry com.apple.provenance xattr ('@') — that is NOT
    // an ACL and must still pass, proving we are not grepping the mode column.
    expect(bash(`${src}; expect_no_acl "${plain}" && echo Y || echo N`).stdout).toContain("Y");
    const a = bash(`chmod +a "user:${os.userInfo().username} allow write,append" "${plain}"`);
    if (a.status === 0) {
      expect(bash(`${src}; expect_no_acl "${plain}" && echo Y || echo N`).stdout).toContain("N");
    }
  });

  it("runner identity parsing compares simple fields only (fail-closed on crafted dupes)", () => {
    const good = '{"agentId":123,"agentName":"lcm-prod-macmini-01","clientId":"abc"}';
    const bad = '{"agentId":123,"agentName":"other-runner","clientId":"abc"}';
    const dup = '{"agentName":"lcm-prod-macmini-01","agentName":"evil","agentId":1}';
    const check = (json: string, name: string, id?: string) =>
      bash(`${src}; runner_identity_matches "$J" "$N" "${id ?? ""}" && echo Y || echo N`, { J: json, N: name });
    expect(check(good, TEST_NAME).stdout).toContain("Y");
    expect(check(bad, TEST_NAME).stdout).toContain("N");
    // duplicate field: greedy match takes the LAST value → mismatch → refuse
    expect(check(dup, TEST_NAME).stdout).toContain("N");
    expect(check(good, TEST_NAME, "123").stdout).toContain("Y");
    expect(check(good, TEST_NAME, "999").stdout).toContain("N");
  });
});

// ---------------------------------------------------------------------------
describe("register.sh (root-owned script running as CI uid)", () => {
  const configStubWithEvidence = `#!/bin/bash
# stub standing in for official config.sh: prove env-vs-argv handling
{ echo "ARGV: $*"; echo "ENV_HAS_TOKEN: $([ -n "\${ACTIONS_RUNNER_INPUT_TOKEN:-}" ] && echo yes || echo no)"; echo "ENV_VALUE: \${ACTIONS_RUNNER_INPUT_TOKEN:-}"; } > evidence.txt
name=""; while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift;; esac; shift; done
[ "$name" = "${TEST_NAME}" ] && { echo "stub" > .credentials; echo "stub" > .env; printf '{"agentId":7,"agentName":"%s"}' "$name" > .runner; }
exit 0
`;

  function runRegister(fx: ReturnType<typeof makeFixture>, token: string, extraArgs = "", stdinIsTty = false) {
    const cmd = `printf '%s\\n' "$TK" | bash "${fx.parent}/register.sh" ${extraArgs}`;
    return bash(cmd, { TK: token }, undefined);
  }

  it("preflight passes on a clean fixture leaf", () => {
    const fx = makeFixture();
    FIXTURES.push(fx.base);
    const r = runRegister(fx, GOOD_TOKEN, "--preflight");
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("preflight OK");
  });

  it("refuses when leaf is missing", () => {
    const fx = makeFixture();
    FIXTURES.push(fx.base);
    fs.rmSync(fx.leaf, { recursive: true, force: true });
    const r = runRegister(fx, GOOD_TOKEN, "--preflight");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("app root missing");
  });

  it("refuses when leaf entry is a symlink (replaced appRoot)", () => {
    const fx = makeFixture();
    FIXTURES.push(fx.base);
    const elsewhere = path.join(fx.base, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.rmSync(fx.leaf, { recursive: true });
    fs.symlinkSync(elsewhere, fx.leaf);
    const r = runRegister(fx, GOOD_TOKEN, "--preflight");
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("refusing");
  });

  it("refuses loosened leaf mode (not 0700)", () => {
    const fx = makeFixture();
    FIXTURES.push(fx.base);
    fs.chmodSync(fx.leaf, 0o755);
    const r = runRegister(fx, GOOD_TOKEN, "--preflight");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("0700");
  });

  it("refuses duplicate/partial state without reading tokens again", () => {
    const fx = makeFixture();
    FIXTURES.push(fx.base);
    fs.writeFileSync(path.join(fx.leaf, ".credentials"), "x");
    const r = runRegister(fx, GOOD_TOKEN, "--preflight");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing duplicate");
  });

  it("fails closed on empty/garbage tokens and never echoes the value", () => {
    const fx = makeFixture();
    FIXTURES.push(fx.base);
    const rEmpty = runRegister(fx, "", "--preflight");
    expect(rEmpty.status).not.toBe(0);
    expect(rEmpty.stderr).toContain("empty token");
    const rBad = runRegister(fx, GOOD_TOKEN + " trailing space", "--preflight");
    expect(rBad.status).not.toBe(0);
    expect(rBad.stderr + rBad.stdout).not.toContain(GOOD_TOKEN);
  });

  it("completes: token reaches config.sh via env ONLY — never argv, then guards created state", () => {
    const fx = makeFixture({ configStub: configStubWithEvidence });
    FIXTURES.push(fx.base);
    const r = runRegister(fx, GOOD_TOKEN);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const evidence = fs.readFileSync(path.join(fx.leaf, "evidence.txt"), "utf8");
    expect(evidence).toContain("ENV_HAS_TOKEN: yes");
    expect(evidence).toContain(`ENV_VALUE: ${GOOD_TOKEN}`);
    expect(evidence).not.toMatch(/ARGV:.*a{64}/); // token NOT in argv
    expect(evidence).toContain("--url"); // official unattended flags used
    expect(evidence).not.toContain("--replace"); // collision-prone flag banned
    expect(evidence).not.toContain("--token"); // token flag banned (env only)
    const creds = fs.statSync(path.join(fx.leaf, ".credentials"));
    expect((creds.mode & 0o777).toString(8)).toBe("600");
    // re-running now trips the duplicate guard
    const r2 = runRegister(fx, GOOD_TOKEN);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain("refusing duplicate");
  });
});

// ---------------------------------------------------------------------------
describe("run-runner.sh + runner-status.sh (CI-uid behaviour)", () => {
  it("wrapper refuses until configured, then execs leaf run.sh with trap env", () => {
    const fx = makeFixture();
    FIXTURES.push(fx.base);
    const unconf = bash(`bash "${fx.parent}/run-runner.sh"`);
    expect(unconf.status).not.toBe(0);
    expect(unconf.stderr).toContain("not configured");

    fs.writeFileSync(path.join(fx.leaf, ".credentials"), "stub");
    const r = bash(`bash "${fx.parent}/run-runner.sh"`, { RUNNER_MANUALLY_TRAP_SIG: "1" });
    expect(r.status, r.stderr).toBe(0);
    const marker = fs.readFileSync(path.join(fx.leaf, "runsh-marker"), "utf8");
    expect(marker).toContain("trap=1");
  });

  it("wrapper rejects a symlinked run.sh inside the leaf", () => {
    const fx = makeFixture();
    FIXTURES.push(fx.base);
    fs.writeFileSync(path.join(fx.leaf, ".credentials"), "stub");
    fs.rmSync(path.join(fx.leaf, "run.sh"));
    fs.symlinkSync(path.join(fx.base, "evil"), path.join(fx.leaf, "run.sh"));
    const r = bash(`bash "${fx.parent}/run-runner.sh"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing");
  });

  it("status probes report configured + identity without leaking file bodies", () => {
    const fx = makeFixture();
    FIXTURES.push(fx.base);
    const noConf = bash(`bash "${fx.parent}/runner-status.sh" configured`);
    expect(noConf.status).toBe(1);
    fs.writeFileSync(path.join(fx.leaf, ".credentials"), "SECRET-CREDENTIALS-BODY");
    fs.writeFileSync(path.join(fx.leaf, ".env"), "x");
    fs.writeFileSync(path.join(fx.leaf, ".runner"), `{"agentId":42,"agentName":"${TEST_NAME}","registrationToken":"DO-NOT-PRINT"}`);
    const conf = bash(`bash "${fx.parent}/runner-status.sh" configured`);
    expect(conf.status).toBe(0);
    const ident = bash(`bash "${fx.parent}/runner-status.sh" identity ${TEST_NAME}`);
    expect(ident.status).toBe(0);
    expect(ident.stdout).toContain("agentId=42");
    expect(ident.stdout).not.toContain("DO-NOT-PRINT");
    expect(ident.stdout).not.toContain("SECRET-CREDENTIALS-BODY");
    const wrong = bash(`bash "${fx.parent}/runner-status.sh" identity other-name`);
    expect(wrong.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("02-install-bundle.sh real logic in fixture mode (no root/network)", () => {
  const officialPkg =
    process.env.LCM_CI_OFFICIAL_PKG ??
    "/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-runner-pkg-cache/actions-runner-osx-arm64-2.338.0.tar.gz";
  const havePkg = existsSync(officialPkg);

  it.skipIf(!havePkg)("installs official appRoot fresh, preserves exec bits, refuses rerun", () => {    const base = tmpBase();
    FIXTURES.push(base);
    const anchor = path.join(base, "Library");
    fs.mkdirSync(anchor, { recursive: true });
    const env = {
      LCM_CI_TEST_MODE: "1",
      LCM_CI_PKG: officialPkg,
      LCM_CI_INSTALL_ANCHOR: anchor,
      LCM_CI_GAMJAWORLD_DIR: path.join(anchor, "Application Support/GamjaWorld"),
      LCM_CI_CI_BASE: path.join(anchor, "Application Support/GamjaWorld/CI"),
      LCM_CI_PARENT: path.join(anchor, "Application Support/GamjaWorld/CI/lcm-production"),
      LCM_CI_APP_ROOT: path.join(anchor, "Application Support/GamjaWorld/CI/lcm-production/app"),
      LCM_CI_LOG_DIR: path.join(base, "varlog/lcm-production"),
      LCM_CI_ACCOUNT: os.userInfo().username,
    };
    const r = bash(`bash "${KIT}/02-install-bundle.sh"`, env);
    expect(r.status, r.stdout + r.stderr).toBe(0);

    // official entrypoints installed with executable modes preserved
    for (const f of ["config.sh", "run.sh", "env.sh", "bin/Runner.Listener"]) {
      const st = fs.statSync(path.join(env.LCM_CI_APP_ROOT, f));
      expect(st.mode & 0o111, f).not.toBe(0);
      expect(st.isFile()).toBe(true);
    }
    // leaf is a real dir 0700 (no symlinks needed for official package
    // contents; those live INSIDE the leaf which root never traverses)
    const leafSt = fs.lstatSync(env.LCM_CI_APP_ROOT);
    expect(leafSt.isDirectory()).toBe(true);
    expect((leafSt.mode & 0o777).toString(8)).toBe("700");
    // parent 0755 owned by us (fixture stand-in for root)
    const parSt = fs.statSync(env.LCM_CI_PARENT);
    expect((parSt.mode & 0o777).toString(8)).toBe("755");
    // public control scripts + manifest present; manifest verifies
    for (const f of ["register.sh", "deregister.sh", "runner-status.sh", "run-runner.sh", "lib.sh", "runner-config.env", "manifest.txt"]) {
      expect(existsSync(path.join(env.LCM_CI_PARENT, f)), f).toBe(true);
    }
    const mf = bash(`grep -v '^#' "${env.LCM_CI_PARENT}/manifest.txt" | shasum -a 256 -c -`, {}, env.LCM_CI_PARENT);
    expect(mf.status, mf.stdout + mf.stderr).toBe(0);
    // log dir 0700, files 0640, NO ACLs anywhere (previous kit's add_file
    // ACL design is gone)
    expect((fs.statSync(env.LCM_CI_LOG_DIR).mode & 0o777).toString(8)).toBe("700");
    for (const l of ["launchd.out.log", "launchd.err.log"]) {
      const st = fs.statSync(path.join(env.LCM_CI_LOG_DIR, l));
      expect((st.mode & 0o777).toString(8)).toBe("640");
      const acl = bash(`source "${KIT}/lib/lib-runner.sh"; expect_no_acl "${path.join(env.LCM_CI_LOG_DIR, l)}" && echo CLEAN || echo ACL`);
      expect(acl.stdout, l).toContain("CLEAN");
    }
    // rerun REFUSES without mutation (fresh-install-only)
    const before = fs.readFileSync(path.join(env.LCM_CI_PARENT, "manifest.txt"));
    const rerun = bash(`bash "${KIT}/02-install-bundle.sh"`, env);
    expect(rerun.status).not.toBe(0);
    expect(rerun.stderr + rerun.stdout).toContain("fresh install");
    const after = fs.readFileSync(path.join(env.LCM_CI_PARENT, "manifest.txt"));
    expect(Buffer.compare(before, after)).toBe(0);
    // tamper: symlinked leaf parent component → refuse
    fs.rmSync(env.LCM_CI_APP_ROOT, { recursive: true, force: true });
    fs.rmSync(path.join(env.LCM_CI_PARENT, "manifest.txt"), { force: true });
    fs.mkdirSync(path.join(base, "elsewhere"));
    fs.symlinkSync(path.join(base, "elsewhere"), env.LCM_CI_APP_ROOT);
    fs.writeFileSync(path.join(env.LCM_CI_PARENT, "manifest.txt"), "x");
    const tampered = bash(`bash "${KIT}/02-install-bundle.sh"`, env);
    expect(tampered.status).not.toBe(0);
  }, 240_000);

  it("refuses a wrong-sha package before touching the leaf", () => {
    const base = tmpBase();
    FIXTURES.push(base);
    const anchor = path.join(base, "Library");
    fs.mkdirSync(anchor, { recursive: true });
    const fakePkg = path.join(base, "fake.tar.gz");
    // a real tarball but with different content → sha mismatch
    fs.mkdirSync(path.join(base, "srcdir"));
    fs.writeFileSync(path.join(base, "srcdir", "a.txt"), "not the official runner");
    const t = bash(`tar -czf "${fakePkg}" -C "${base}/srcdir" a.txt`);
    if (t.status !== 0) return; // tar unavailable in odd environments — skip quietly
    const env = {
      LCM_CI_TEST_MODE: "1",
      LCM_CI_PKG: fakePkg,
      LCM_CI_INSTALL_ANCHOR: anchor,
      LCM_CI_GAMJAWORLD_DIR: path.join(anchor, "Application Support/GamjaWorld"),
      LCM_CI_CI_BASE: path.join(anchor, "Application Support/GamjaWorld/CI"),
      LCM_CI_PARENT: path.join(anchor, "Application Support/GamjaWorld/CI/lcm-production"),
      LCM_CI_APP_ROOT: path.join(anchor, "Application Support/GamjaWorld/CI/lcm-production/app"),
      LCM_CI_LOG_DIR: path.join(base, "varlog/lcm-production"),
      LCM_CI_ACCOUNT: os.userInfo().username,
    };
    const r = bash(`bash "${KIT}/02-install-bundle.sh"`, env);
    expect(r.status).not.toBe(0);
    // FAILED must not leave a leaf behind (staging cleaned)
    expect(existsSync(env.LCM_CI_APP_ROOT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("official v2.338.0 package behaviour proof (normal owner, no registration)", () => {
  const officialPkg =
    process.env.LCM_CI_OFFICIAL_PKG ??
    "/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-runner-pkg-cache/actions-runner-osx-arm64-2.338.0.tar.gz";
  const havePkg = existsSync(officialPkg);

  it.skipIf(!havePkg)("Runner.Listener --help runs from extracted appRoot; scripts self-locate", () => {
    const base = tmpBase();
    FIXTURES.push(base);
    const app = path.join(base, "app");
    fs.mkdirSync(app);
    fs.chmodSync(base, 0o700);
    const ex = bash(`tar -xzf "${officialPkg}" -C "${app}"`);
    expect(ex.status).toBe(0);
    // version + help WITHOUT any registration
    const ver = bash(`"${app}/bin/Runner.Listener" --version`);
    expect(ver.status).toBe(0);
    expect(ver.stdout.trim()).toBe("2.338.0");
    const help = bash(`"${app}/bin/Runner.Listener" --help`);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("./config.sh");
    expect(help.stdout).toContain("./run.sh");
    // config.sh refuses root (so our sudo -u CI flow is the only way)
    const cfg = fs.readFileSync(path.join(app, "config.sh"), "utf8");
    expect(cfg).toContain("Must not run with sudo");
    // config.sh cd's to its own directory: .credentials/.env/.runner live in
    // the SAME appRoot as the binaries (kills the old bundle/working split)
    expect(cfg).toMatch(/cd "\$DIR"/);
    expect(cfg).toContain("./env.sh");
    // official package has no svc.sh/runsvc.sh in this version (plist uses
    // run.sh via the root wrapper instead)
    expect(existsSync(path.join(app, "runsvc.sh"))).toBe(false);
    expect(existsSync(path.join(app, "svc.sh"))).toBe(false);
  }, 240_000);
});

// ---------------------------------------------------------------------------
describe("workflow + plist specification-level guards", () => {
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const dep = fs.readFileSync(path.join(ROOT, ".github/workflows/deploy-pages.yml"), "utf8");
  const plist = fs.readFileSync(path.join(KIT, "com.gamjaworld.lcm-ci-actions-runner.plist.template"), "utf8");

  it("ci.yml triggers only push to protected main; no dispatch/PR path", () => {
    expect(ci).toContain("push:");
    expect(ci).toContain("branches: [main]");
    expect(ci.split("\n").filter((l) => /^\s*workflow_dispatch:/.test(l))).toHaveLength(0);
    expect(ci.split("\n").filter((l) => /^\s*pull_request/.test(l))).toHaveLength(0);
    expect(ci).toContain("needs: [preflight]");
    expect(ci).toContain("event is not push");
  });

  it("deploy gate: needs chain before environment; artifact handoff; no rebuild", () => {
    expect(dep.split("\n").filter((l) => /^\s*workflow_dispatch:/.test(l)).length).toBe(1); // deploy allowed, ci not
    expect(ci.split("\n").filter((l) => /^\s*workflow_dispatch:/.test(l))).toHaveLength(0);
    expect(dep).toContain("needs: [verify-ci]"); // preflight gated on verify-ci
    expect(dep).toContain("needs: [verify-ci, preflight]"); // deploy gated too
    expect(dep).toContain("environment:");
    expect(dep).toContain("actions: read");
    const deployJob = dep.split("deploy:")[1] ?? "";
    expect(deployJob).not.toContain("Build static FE"); // no unresolved autobuild after approval
    expect(deployJob).not.toContain("pnpm install");
    expect(dep).toContain("lcm-release-${{ github.sha }}");
    expect(dep).toContain("run-id: ${{ needs.verify-ci.outputs.ci-run-id }}");
    expect(dep).toContain("release-gate.mjs verify");
    expect(dep).toContain("--attempt");
  });

  it("wrangler stays locked + pre-installed, secret steps keep CF env only at deploy", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/wrangler/package-lock.json"), "utf8"));
    expect(lock.packages[""].dependencies.wrangler).toBe("4.131.1");
    expect(dep).toContain("npm ci --ignore-scripts");
    expect(dep).toContain("tools/wrangler/node_modules/.bin/wrangler");
    expect(dep).not.toMatch(/npx wrangler/);
  });

  it("plist: root wrapper program + uid/gid drop + official leaf workingdir + trap env + no svc refs", () => {
    expect(plist).toContain("__PARENT__/run-runner.sh");
    expect(plist).not.toContain("runsvc.sh");
    expect(plist).toContain("<key>UserName</key>");
    expect(plist).toContain("<key>GroupName</key>");
    expect(plist).toContain("<string>__ACCOUNT__</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("__LEAF__");
    expect(plist).toContain("RUNNER_MANUALLY_TRAP_SIG");
    expect(plist).toContain("SuccessfulExit");
    expect(plist).toContain("__LOG_DIR__/launchd.out.log");
  });

  it("kit scripts contain no Owner-home execution paths (CI cannot read /Users/sanghyun)", () => {
    for (const f of ["rootctl/register.sh", "rootctl/deregister.sh", "rootctl/runner-status.sh", "rootctl/run-runner.sh", "lib/lib-runner.sh"]) {
      const s = fs.readFileSync(path.join(KIT, f), "utf8");
      expect(s, f).not.toMatch(/\/Users\/sanghyun\/[^"']*\.sh/);
      expect(s, f).not.toMatch(/BUNDLE_ROOT.*config\.sh/);
    }
    // numbered scripts use env-derived public paths only (defaults point at
    // /Library/... — runner-config installed copy has no repo-relative HERE use
    // for execution of CI-side code)
    for (const f of ["03-register-runner.sh", "04-install-launchd.sh", "06-remove.sh"]) {
      const s = fs.readFileSync(path.join(KIT, f), "utf8");
      expect(s, f).not.toMatch(/^\s*.*\/Users\/sanghyun\/.*\.sh/m);
    }
  });

  it("obsolete split-bundle design is fully removed (no svc invocation, working-dir/--replace/--env-argv routes left)", () => {
    expect(existsSync(path.join(KIT, "00-bootstrap-bundle.sh"))).toBe(false);
    expect(existsSync(path.join(KIT, "02-register-runner.sh"))).toBe(false);
    const all = ["01-create-account.sh", "02-install-bundle.sh", "03-register-runner.sh", "04-install-launchd.sh", "05-verify.sh", "06-remove.sh"];
    for (const f of all) {
      const s = fs.readFileSync(path.join(KIT, f), "utf8");
      // never invoked, even in comments-as-command patterns:
      expect(s, f).not.toMatch(/config\.sh[^#\n]*--replace/);
      expect(s, f).not.toContain("RUNNER_WORK_DIR");
      expect(s, f).not.toContain("CI/lcm-runner");
      expect(s, f).not.toMatch(/chmod \+a/); // ACL approach removed from live code
      expect(s, f).not.toMatch(/env "ACTIONS_RUNNER_INPUT_TOKEN=/); // argv-visible env cmd removed
    }
  });

  it("06-remove.sh validates ALL preconditions (token+identity) before stopping", () => {
    const s = fs.readFileSync(path.join(KIT, "06-remove.sh"), "utf8");
    const tokenIdx = s.indexOf("precondition: removal token");
    const identityIdx = s.indexOf("identity check");
    const bootoutIdx = s.indexOf("launchctl bootout");
    expect(tokenIdx).toBeGreaterThan(-1);
    expect(identityIdx).toBeGreaterThan(tokenIdx);
    expect(bootoutIdx).toBeGreaterThan(identityIdx);
    // no destructive ops on other runners / account / data — destructive
    // commands may only appear inside echo'd manual-teardown guidance, never
    // at executable statement position.
    const execLines = s.split("\n").filter((l) => !/^\s*(#|echo|})/.test(l));
    expect(execLines.some((l) => /^\s*(sudo\s+)?(rm\s+-rf|pkill|killall)/.test(l) || /^\s*dscl .* -delete/.test(l))).toBe(false);
    expect(s).not.toContain("pkill");
    expect(s).not.toContain("killall");
  });

  it("ephemeral PG harness unchanged: unix socket only, peer auth, no TCP (461-test setup)", () => {
    const s = fs.readFileSync(path.join(ROOT, "scripts/ci/ephemeral-postgres.mjs"), "utf8");
    expect(s).toContain("listen_addresses=''");
    expect(s).toContain("--auth-local=peer");
    expect(s).toContain("--auth-host=reject");
    expect(s).not.toContain("-A trust");
  });
});
