#!/usr/bin/env python3
"""Create a private clean-source build receipt, without provider credentials/deploy.

Uses existing offline pnpm cache only. Public comparison is byte evidence, not a
claim that remote metadata or customer flows prove source provenance.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone

API_BASE = 'https://api.gamja.top/living-cost-manager/v1'
PUBLIC_BASE = 'https://living-cost-manager.gamja.top'
TEMP_ROOT = Path('/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def public_bytes(url):
    # curl transport matches the operator's public read-only checks; do not
    # inherit a provider credential or log response headers/error bodies.
    result = subprocess.run(['curl', '--disable', '--fail', '--silent', '--show-error',
                             '--max-time', '30', url], capture_output=True)
    if result.returncode:
        raise RuntimeError('Public fetch failed')
    return result.stdout


def equivalence_passes(receipt):
    return receipt.get('all_compared_public_js_match', False) and not receipt.get('public_route_errors')


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9]{40}', sys.argv[1]):
        raise SystemExit('Usage: templates-clean-build-proof.py FULL_REVIEWED_COMMIT_SHA')
    commit = sys.argv[1]
    repo = Path(__file__).resolve().parents[1]
    # Resolve immutable source first; do not archive the dirty implementation tree.
    actual = subprocess.check_output(['git', 'rev-parse', commit + '^{commit}'], cwd=repo, text=True).strip()
    if actual != commit:
        raise SystemExit('Commit identity mismatch')
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix='lcm-clean-proof-', dir=TEMP_ROOT))
    source = root / 'source'
    source.mkdir(mode=0o700)
    archive = root / 'source.tar'
    with archive.open('wb') as stream:
        subprocess.run(['git', 'archive', '--format=tar', commit], cwd=repo, stdout=stream, check=True)
    with tarfile.open(archive) as bundle:
        bundle.extractall(source, filter='data')
    receipt = dict(source_commit=commit, source_archive_sha256=sha(archive.read_bytes()),
                   api_base=API_BASE, public_origin=PUBLIC_BASE,
                   started_utc=datetime.now(timezone.utc).isoformat(), commands=[],
                   deploy_performed=False, dependency_source='existing_offline_pnpm_cache',
                   independent_review='pending')
    # Do not inherit provider tokens, DB URLs or incidental public env variables.
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR') if key in os.environ}
    env.update(CI='1', NEXT_TELEMETRY_DISABLED='1', NEXT_PUBLIC_API_BASE_URL=API_BASE)
    commands = [ ['pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'],
                 ['pnpm', '--filter', '@living-cost-manager/shared', 'build'],
                 ['pnpm', '--filter', '@living-cost-manager/web', 'build'] ]
    path = root / 'receipt.json'
    def persist():
        path.write_text(json.dumps(receipt, indent=2) + '\n')
    persist()
    for index, command in enumerate(commands):
        with (root / f'command-{index}.log').open('wb') as log:
            result = subprocess.run(command, cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT)
        receipt['commands'].append(dict(argv=command, exit=result.returncode))
        persist()
        if result.returncode:
            print(f'Build step {index} failed; private receipt: {path}')
            return result.returncode
    out = source / 'apps/web/out'
    assets = {str(p.relative_to(out)): sha(p.read_bytes()) for p in sorted(out.rglob('*')) if p.is_file()}
    manifest = root / 'artifact-manifest.json'
    manifest.write_text(json.dumps(assets, sort_keys=True, indent=2) + '\n')
    receipt['artifact_manifest_sha256'] = sha(manifest.read_bytes())
    receipt['artifact_file_count'] = len(assets)
    receipt['artifact_api_base_present'] = any(API_BASE.encode() in p.read_bytes() for p in out.rglob('*.js'))
    receipt['public_js_comparison'] = []
    references = set()
    for route in ('/', '/guide/templates/'):
        try:
            html = public_bytes(PUBLIC_BASE + route).decode('utf-8')
            references.update(re.findall(r'(?:src|href)="(/_next/static/[^"?]+\.js)(?:\?[^"\s]*)?"', html))
        except Exception:
            receipt.setdefault('public_route_errors', []).append(route)
    for asset in sorted(references):
        local = out / asset.lstrip('/')
        record = dict(path=asset, local_present=local.is_file())
        if local.is_file():
            try:
                public = public_bytes(PUBLIC_BASE + asset)
                record.update(local_sha256=sha(local.read_bytes()), public_sha256=sha(public),
                              byte_match=local.read_bytes() == public)
            except Exception:
                record['fetch_failed'] = True
        receipt['public_js_comparison'].append(record)
    receipt['all_compared_public_js_match'] = bool(references) and all(
        r.get('byte_match', False) for r in receipt['public_js_comparison'])
    receipt['completed_utc'] = datetime.now(timezone.utc).isoformat()
    persist()
    for evidence in (archive, manifest, path):
        evidence.chmod(0o400)
    print(f'Private receipt: {path}')
    print(f'Clean build exit=0; assets={len(assets)}; public JS compared={len(references)}; '
          f'all byte matches={receipt["all_compared_public_js_match"]}')
    return 0 if equivalence_passes(receipt) else 2


if __name__ == '__main__':
    sys.exit(main())
