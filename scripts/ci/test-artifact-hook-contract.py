#!/usr/bin/env python3
"""Offline static contract tests; never invoke OpsKV, Drive, SSH, or product APIs."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text()


def run_block(step_name):
    lines = WORKFLOW.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {step_name}")
    run_at = next(i for i in range(start, len(lines)) if lines[i].strip() == "run: |")
    block = []
    for line in lines[run_at + 1:]:
        if line and not line.startswith("          "):
            break
        block.append(line[10:] if line.startswith("          ") else "")
    return "\n".join(block)


class ArtifactHookContract(unittest.TestCase):
    def test_fixed_bundle_and_contract_preflight_before_mutations(self):
        self.assertIn("5f4be635abf51fceed452dd59c66db4eee3c414203be655848953b7538491fe7", WORKFLOW)
        self.assertIn('test -f "$ROOT/tools/cicd/pipeline.py"', WORKFLOW)
        api = WORKFLOW.split("api-deploy:", 1)[1].split("# Production Pages deploy", 1)[0]
        self.assertLess(api.index("pipeline.py\" preflight --service living-cost-manager"), api.index("install-helper"))
        fe = WORKFLOW.split("  deploy:\n    name: Deploy verified artifact", 1)[1]
        self.assertLess(fe.index("pipeline.py\" preflight --service living-cost-manager"), fe.index("pages deploy release/out"))

    def test_api_promoted_image_archive_precedes_cleanup_and_uses_existing_image(self):
        api = WORKFLOW.split("api-deploy:", 1)[1].split("# Production Pages deploy", 1)[0]
        self.assertLess(api.index("verify-public"), api.index("Archive verified API image"))
        self.assertLess(api.index("register-opskv"), api.index("Archive verified API image"))
        self.assertLess(api.index("Archive verified API image"), api.index("Remove large transient files"))
        self.assertIn("--file dist-api/image.tar.gz --file dist-api/metadata.json", api)
        self.assertNotIn("docker save", api[api.index("Archive verified API image"):])
        archive = api.split("Archive verified API image", 1)[1].split("Remove large transient files", 1)[0]
        self.assertNotIn("deploy.mjs", archive)
        self.assertIn("if: success()", archive)
        cleanup = api.split("Remove large transient files", 1)[1]
        self.assertIn('steps.archive_api.outcome }}" = "failure"', cleanup)
        self.assertIn("Preserve the exact local image tar", archive)
        self.assertIn("rm -rf \"$GITHUB_WORKSPACE/dist-api\"", cleanup)

    def test_ui_archive_only_after_deploy_and_existing_identity_guard(self):
        fe = WORKFLOW.split("  deploy:\n    name: Deploy verified artifact", 1)[1]
        self.assertLess(fe.index("pages deploy release/out"), fe.index("Verify deployed release identity"))
        self.assertLess(fe.index("Verify deployed release identity"), fe.index("Archive verified Pages release files"))
        self.assertLess(fe.index("archive-budget.mjs"), fe.index("tar -czf"))
        archive = fe.split("Archive verified Pages release files", 1)[1]
        self.assertIn("continue-on-error: true", archive)
        self.assertIn("--verified-deployment", archive)
        self.assertIn("tar -czf", archive)
        self.assertIn("archive-budget.mjs", archive)
        self.assertIn("trap 'rm -rf \"$tmpdir\"' EXIT", archive)
        self.assertNotIn("pages deploy", archive)

    def test_archive_failure_is_non_mutating_and_existing_safety_gates_remain(self):
        self.assertIn("continue-on-error: true", WORKFLOW)
        self.assertIn("15GiB", WORKFLOW)
        budget = (ROOT / "scripts/ci/archive-budget.mjs").read_text()
        self.assertIn("BigInt(rawBytes) * BigInt(PEAK_FACTOR_NUMERATOR)", budget)
        self.assertIn("BigInt(FLOOR_BYTES) + BigInt(RESERVE_BYTES) + peak", budget)
        self.assertNotIn("process.env.*FLOOR", budget)
        self.assertIn("needs.api-deploy.result == 'success'", WORKFLOW)
        self.assertIn("cleanup-copy --out-dir", WORKFLOW)
        self.assertIn("actions/download-artifact", WORKFLOW)

    def test_api_archive_step_executes_only_mock_cli_and_reports_failure(self):
        block = run_block("Archive verified API image and trace metadata")
        with tempfile.TemporaryDirectory(prefix="lcm-mock-api-archive-") as td:
            home = Path(td)
            workspace = home / "workspace"
            files = workspace / "dist-api"
            files.mkdir(parents=True)
            (files / "image.tar.gz").write_bytes(b"fake image archive")
            (files / "metadata.json").write_text('{"kind":"trace-only"}')
            helper = home / ".local/share/gamjaworld-cli/releases/5f4be635abf51fceed452dd59c66db4eee3c414203be655848953b7538491fe7/tools/cicd"
            helper.mkdir(parents=True)
            (helper / "pipeline.py").write_text(textwrap.dedent('''\
                import json, os, sys
                open(os.environ["MOCK_RECORD"], "w").write(json.dumps(sys.argv[1:]))
                raise SystemExit(17)
            '''))
            record, summary = home / "args.json", home / "summary.txt"
            env = dict(os.environ, HOME=str(home), GITHUB_WORKSPACE=str(workspace),
                       API_ARCHIVE_ID="a" * 40 + "-77-1-api", MOCK_RECORD=str(record),
                       GITHUB_OUTPUT=str(home / "output.txt"), GITHUB_STEP_SUMMARY=str(summary))
            result = subprocess.run(["/bin/bash", "-e", "-o", "pipefail", "-c", block], env=env,
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 1)
            args = json.loads(record.read_text())
            self.assertEqual(args.count("--file"), 2)
            self.assertIn("dist-api/image.tar.gz", args)
            self.assertIn("dist-api/metadata.json", args)
            self.assertIn("--verified-deployment", args)
            self.assertIn("not retried or rolled back", summary.read_text())
            self.assertIn("archived=false", (home / "output.txt").read_text())

    def test_ui_archive_step_packages_existing_fixture_with_mock_cli_failure(self):
        block = run_block("Archive verified Pages release files")
        with tempfile.TemporaryDirectory(prefix="lcm-mock-ui-archive-") as td:
            home = Path(td)
            workspace = home / "workspace"
            release = workspace / "release"
            (release / "out/a").mkdir(parents=True)
            (release / "out/b").mkdir(parents=True)
            (release / "out/a/index.html").write_text("A")
            (release / "out/b/index.html").write_text("B")
            (release / "build-info.json").write_text('{"source":"fixture"}')
            budget_dest = workspace / "scripts/ci/archive-budget.mjs"
            budget_dest.parent.mkdir(parents=True)
            shutil.copy2(ROOT / "scripts/ci/archive-budget.mjs", budget_dest)
            helper = home / ".local/share/gamjaworld-cli/releases/5f4be635abf51fceed452dd59c66db4eee3c414203be655848953b7538491fe7/tools/cicd"
            helper.mkdir(parents=True)
            (helper / "pipeline.py").write_text(textwrap.dedent('''\
                import json, os, sys, tarfile
                args=sys.argv[1:]
                p=args[args.index("--file") + 1]
                with tarfile.open(p, "r:gz") as archive:
                    names=set(archive.getnames())
                assert "./out/a/index.html" in names and "./out/b/index.html" in names
                open(os.environ["MOCK_RECORD"], "w").write(json.dumps(args))
                raise SystemExit(17)
            '''))
            runner_temp = home / "runner-temp"
            runner_temp.mkdir(mode=0o700)
            record, summary = home / "args.json", home / "summary.txt"
            env = dict(os.environ, HOME=str(home), GITHUB_WORKSPACE=str(workspace),
                       RUNNER_TEMP=str(runner_temp), UI_ARCHIVE_ID="b" * 40 + "-77-1-ui",
                       MOCK_RECORD=str(record), GITHUB_STEP_SUMMARY=str(summary))
            result = subprocess.run(["/bin/bash", "-e", "-o", "pipefail", "-c", block],
                                    cwd=workspace, env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            args = json.loads(record.read_text())
            self.assertIn("--verified-deployment", args)
            self.assertEqual(args[args.index("--file") + 1].split("/")[-1], "lcm-pages-release.tar.gz")
            self.assertIn("not retried or rolled back", summary.read_text())
            self.assertEqual(list(runner_temp.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
