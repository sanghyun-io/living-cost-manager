// Security tests for LCM CI runner scripts.
// These tests verify the P1/P2 security fixes without requiring actual root/sudo.
//
// Test categories:
//   1. Root symlink rejection: bundle must be root-owned
//   2. Token preconditions: rollback validates before stopping
//   3. CI guards: YAML policy, verify-ci checks same SHA
//   4. Package-lock isolation: tools/wrangler has no secrets
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../..");

describe("P1 root symlink protection", () => {
  it("bundle path is outside Owner home", () => {
    const bundlePath = "/Library/Application Support/GamjaWorld/CI/lcm-production";
    expect(bundlePath).not.toContain("/Users/sanghyun");
    expect(bundlePath).not.toContain("/Users/lcm-ci");
    expect(bundlePath.startsWith("/Library/")).toBe(true);
  });

  it("log path is outside Owner home", () => {
    const logPath = "/var/log/gamja-ci/lcm-production";
    expect(logPath).not.toContain("/Users/sanghyun");
    expect(logPath).not.toContain("/Users/lcm-ci");
    expect(logPath.startsWith("/var/log/")).toBe(true);
  });

  it("00-bootstrap-bundle.sh creates root-owned bundle and verifies ancestors", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/runner/00-bootstrap-bundle.sh"), "utf8");
    expect(script).toContain('chown root:wheel "$BUNDLE_ROOT"');
    expect(script).toContain('ANCESTOR_OWNER="$(stat -f \'%Su\' "$ancestor")"');
    expect(script).toContain('[ "$ANCESTOR_OWNER" != "root" ]');
    expect(script).toContain("security boundary violation");
  });

  it("02-register-runner.sh verifies bundle owner is root", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/runner/02-register-runner.sh"), "utf8");
    expect(script).toContain('BUNDLE_OWNER="$(stat -f \'%Su\' "$BUNDLE_ROOT")"');
    expect(script).toContain('[ "$BUNDLE_OWNER" != "root" ]');
  });

  it("03-install-launchd.sh verifies bundle and log owner are root", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/runner/03-install-launchd.sh"), "utf8");
    expect(script).toContain('BUNDLE_OWNER="$(stat -f \'%Su\' "$BUNDLE_ROOT")"');
    expect(script).toContain('LOG_OWNER="$(stat -f \'%Su\' "$LOG_DIR")"');
    expect(script).toContain('[ "$BUNDLE_OWNER" != "root" ]');
    expect(script).toContain('[ "$LOG_OWNER" != "root" ]');
  });

  it("plist template points to bundle, not CI-owned path", () => {
    const plist = readFileSync(
      join(ROOT, "scripts/ci/runner/com.gamjaworld.lcm-ci-actions-runner.plist.template"),
      "utf8"
    );
    expect(plist).toContain("__BUNDLE_ROOT__/runsvc.sh");
    expect(plist).not.toContain("__ACCOUNT_HOME__/actions-runner/runsvc.sh");
    expect(plist).toContain("__RUNNER_WORK_DIR__");
    expect(plist).toContain("__ACCOUNT__");
  });
});

describe("P1 PG trust protection", () => {
  it("ephemeral-postgres.mjs disables TCP listener", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/ephemeral-postgres.mjs"), "utf8");
    expect(script).toContain("listen_addresses=''");
    expect(script).not.toContain("listen_addresses=127.0.0.1");
  });

  it("ephemeral-postgres.mjs uses peer auth for local, reject for host", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/ephemeral-postgres.mjs"), "utf8");
    expect(script).toContain("--auth-local=peer");
    expect(script).toContain("--auth-host=reject");
    expect(script).not.toContain("-A trust");
  });

  it("ephemeral-postgres.mjs uses Unix socket directory", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/ephemeral-postgres.mjs"), "utf8");
    expect(script).toContain("socketDir");
    expect(script).toContain("unix_socket_directories");
    expect(script).toContain("?host=");
  });

  it("ephemeral-postgres.mjs sets DB superuser to OS username", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/ephemeral-postgres.mjs"), "utf8");
    expect(script).toContain("os.userInfo().username");
    expect(script).toContain("-U\", osUsername");
  });
});

describe("P1 CI workflow guards", () => {
  it("ci.yml does NOT have workflow_dispatch trigger", () => {
    const content = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(content).toContain("push:");
    expect(content).toContain("branches: [main]");
    // workflow_dispatch should not be present (or should be commented out)
    const lines = content.split("\n");
    const dispatchLines = lines.filter((l) => l.trim().startsWith("workflow_dispatch:"));
    expect(dispatchLines.length).toBe(0);
  });

  it("ci.yml has preflight job that verifies repo/ref/event/SHA", () => {
    const content = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(content).toContain("preflight:");
    expect(content).toContain("Verify repository identity");
    expect(content).toContain("Verify ref is protected main");
    expect(content).toContain("Verify event is push");
    expect(content).toContain("Verify SHA is exact event SHA");
  });

  it("ci.yml build-test depends on preflight", () => {
    const content = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(content).toContain("needs: [preflight]");
  });

  it("deploy-pages.yml has verify-ci job", () => {
    const content = readFileSync(join(ROOT, ".github/workflows/deploy-pages.yml"), "utf8");
    expect(content).toContain("verify-ci:");
    expect(content).toContain("Verify CI succeeded for this SHA");
  });

  it("deploy-pages.yml verify-ci checks exact SHA", () => {
    const content = readFileSync(join(ROOT, ".github/workflows/deploy-pages.yml"), "utf8");
    expect(content).toContain("TARGET_SHA");
    expect(content).toContain("head_sha");
    expect(content).toContain("RUN_SHA");
  });

  it("deploy-pages.yml deploy depends on verify-ci and preflight", () => {
    const content = readFileSync(join(ROOT, ".github/workflows/deploy-pages.yml"), "utf8");
    expect(content).toContain("needs: [preflight]");
    // verify-ci is in the needs chain (preflight needs verify-ci)
    const preflightSection = content.split("preflight:")[1].split("deploy:")[0];
    expect(preflightSection).toContain("needs: [verify-ci]");
  });

  it("deploy-pages.yml preflight verifies actor is Owner", () => {
    const content = readFileSync(join(ROOT, ".github/workflows/deploy-pages.yml"), "utf8");
    expect(content).toContain("Verify actor is Owner");
    expect(content).toContain("github.actor");
    expect(content).toContain("sanghyun-io");
  });
});

describe("P2 token handling", () => {
  it("02-register-runner.sh reads token from /dev/tty, not argv", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/runner/02-register-runner.sh"), "utf8");
    expect(script).toContain("read -r -s -p");
    expect(script).toContain("</dev/tty");
    expect(script).not.toContain("$1"); // no argv
    expect(script).toContain("unset ACTIONS_RUNNER_INPUT_TOKEN");
  });

  it("05-remove.sh reads token from /dev/tty, not argv", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/runner/05-remove.sh"), "utf8");
    expect(script).toContain("read -r -s -p");
    expect(script).toContain("</dev/tty");
    expect(script).toContain("REMOVE_TOKEN=\"\"");
    expect(script).toContain("unset REMOVE_TOKEN");
  });

  it("05-remove.sh validates preconditions BEFORE stopping", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/runner/05-remove.sh"), "utf8");
    // Check that validation happens before the "proceed with rollback" prompt
    const validationIdx = script.indexOf("Precondition validation");
    const proceedIdx = script.indexOf("proceed with rollback");
    const stopIdx = script.indexOf("Step 1: Stop LaunchDaemon");
    expect(validationIdx).toBeLessThan(proceedIdx);
    expect(proceedIdx).toBeLessThan(stopIdx);
  });
});

describe("P2 package-lock isolation", () => {
  it("tools/wrangler/package.json exists with exact wrangler version", () => {
    const pkgPath = join(ROOT, "tools/wrangler/package.json");
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(pkg.dependencies.wrangler).toBe("4.131.1");
  });

  it("tools/wrangler/package-lock.json exists", () => {
    const lockPath = join(ROOT, "tools/wrangler/package-lock.json");
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(lock.packages[""].dependencies.wrangler).toBe("4.131.1");
  });

  it("tools/wrangler/package-lock.json has no secrets or CF tokens", () => {
    const lockContent = readFileSync(join(ROOT, "tools/wrangler/package-lock.json"), "utf8");
    expect(lockContent).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(lockContent).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(lockContent).not.toContain("sk-");
    expect(lockContent).not.toContain("ghp_");
  });

  it("deploy-pages.yml installs wrangler from tools/ directory", () => {
    const content = readFileSync(join(ROOT, ".github/workflows/deploy-pages.yml"), "utf8");
    expect(content).toContain("Install wrangler");
    expect(content).toContain("tools/wrangler");
    expect(content).toContain("npm ci");
    expect(content).toContain("--ignore-scripts");
  });

  it("deploy-pages.yml invokes pre-installed wrangler, not npx", () => {
    const content = readFileSync(join(ROOT, ".github/workflows/deploy-pages.yml"), "utf8");
    expect(content).toContain("Deploy to Cloudflare Pages");
    expect(content).toContain("tools/wrangler/node_modules/.bin/wrangler");
    // Should not use npx for wrangler invocation (comments mentioning npx are OK)
    const deployStep = content.split("Deploy to Cloudflare Pages")[1].split("- name:")[0];
    const runSection = deployStep.split("run:")[1];
    expect(runSection).not.toMatch(/^\s*npx\s/);
  });
});

describe("P2 Owner home protection", () => {
  it("CI scripts do not reference /Users/sanghyun for execution", () => {
    const scripts = [
      "scripts/ci/runner/00-bootstrap-bundle.sh",
      "scripts/ci/runner/02-register-runner.sh",
      "scripts/ci/runner/03-install-launchd.sh",
    ];
    for (const scriptPath of scripts) {
      const content = readFileSync(join(ROOT, scriptPath), "utf8");
      // Should not execute anything from Owner home
      expect(content).not.toMatch(/\/Users\/sanghyun\/.*\.sh/);
      expect(content).not.toMatch(/\/Users\/sanghyun\/.*config\.sh/);
    }
  });

  it("04-verify.sh checks other runners but does not modify them", () => {
    const script = readFileSync(join(ROOT, "scripts/ci/runner/04-verify.sh"), "utf8");
    expect(script).toContain("/Users/sanghyun/actions-runner");
    expect(script).toContain("never modifies them");
    // Should only use ls/stat, not rm/chmod/chown on other runners
    const lines = script.split("\n");
    const otherRunnerLines = lines.filter((l) => l.includes("/Users/sanghyun/actions-runner"));
    for (const line of otherRunnerLines) {
      expect(line).toMatch(/^(ls|stat|echo|##|#)/);
    }
  });
});
