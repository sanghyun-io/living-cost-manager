"""Synthetic executable-level tests: no SSH, Docker daemon or customer data."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path('/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode')
SCRIPT = Path(__file__).with_name('templates-oci-restore-proof.sh')

DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]; mode=os.environ['FAKE_MODE']; root=Path(os.environ['FAKE_ROOT'])
state=root/'state.json'; events=root/'events.jsonl'
with events.open('a') as f:f.write(json.dumps(args)+'\n')
s=json.loads(state.read_text()) if state.exists() else {}
if args[:2]==['image','inspect']:sys.exit(0)
if args[:2]==['container','ls']:
 if mode=='daemon_unavailable':sys.exit(70)
 if mode=='preexisting_name' and not state.exists():
  s={'present':True,'name':'lcm-restore-proof-synthetic-owned-id','label':'another-owner'}
  state.write_text(json.dumps(s))
 if s.get('present'): print(s['name'])
 sys.exit(0)
if args[0]=='run':
 s={'present':True,'name':args[args.index('--name')+1],
    'label':args[args.index('--label')+1].split('=',1)[1]}
 if mode=='wrong_owner':s['label']='another-owner'
 state.write_text(json.dumps(s))
 sys.exit(42 if mode in ['startup_failure','wrong_owner','startup_and_cleanup_failure'] else 0)
if args[0]=='inspect':
 if mode=='inspect_failure':sys.exit(72)
 if not s.get('present'):sys.exit(1)
 fmt=args[args.index('--format')+1]
 print(s['label'] if 'lcm.restore.owner' in fmt else 'none' if 'NetworkMode' in fmt else '0')
 sys.exit(0)
if args[0]=='rm':
 if mode in ['cleanup_failure','startup_and_cleanup_failure']:sys.exit(71)
 assert args[1:3]==['-f','-v'] and args[3]==s['name']
 s['present']=False;state.write_text(json.dumps(s));sys.exit(0)
if args[0]=='exec':
 if 'pg_isready' in args:sys.exit(0)
 if 'pg_restore' in args:
  sys.stdin.buffer.read(); print('synthetic restore diagnostic');print('synthetic stderr',file=sys.stderr)
  sys.exit(43 if mode=='restore_failure' else 0)
 if 'pg_dump' in args:print('synthetic schema only');sys.exit(0)
 if 'psql' in args:
  if '-v' in args:
   sys.stdin.buffer.read();s['migrated']=True;state.write_text(json.dumps(s));print('COMMIT');sys.exit(0)
  query=args[-1]
  print('15' if s.get('migrated') else '13') if 'count(*)' in query else print('synthetic_constraint|p|t')
  sys.exit(0)
sys.exit(90)
'''

SUDO = r'''#!/usr/bin/env python3
import os,sys
from pathlib import Path
args=sys.argv[1:]; mode=os.environ['FAKE_MODE']
if args[:3]==['stat','-c','%a:%u']:print('700:0');sys.exit(0)
if args[:3]==['stat','-c','%a']:print('600');sys.exit(0)
if args[:3]==['sh','-c', 'umask 077; set -C; out=$1; err=$2; shift 2; exec "$@" > "$out" 2> "$err"']:
 out=Path(args[4]);err=Path(args[5])
 if mode=='restore_writer_failure' and out.name=='restore.stdout':sys.exit(73)
 if mode=='migration_writer_failure' and out.name=='migration.stdout':sys.exit(74)
 if mode=='stderr_open_failure' and out.name=='restore.stdout':err.mkdir()
os.execvp(args[0],args)
'''


class RestoreProofTests(unittest.TestCase):
    def exercise(self, mode):
        # This temporary fixture and fake commands are entirely test-owned.
        with tempfile.TemporaryDirectory(prefix='lcm-proof-unit-', dir=ROOT) as folder:
            root = Path(folder)
            release = root / 'release'
            release.mkdir(mode=0o700)
            migration = release / 'build/prisma/migrations/20261006160000_budget_templates/migration.sql'
            migration.parent.mkdir(parents=True)
            migration.write_text('-- synthetic migration only\n')
            backup = root / 'synthetic.dump'
            backup.write_bytes(b'synthetic fixture, no rows')
            backup.chmod(0o600)
            binpath = root / 'bin'
            binpath.mkdir()
            for name, body in [('docker', DOCKER), ('sudo', SUDO)]:
                executable = binpath / name
                executable.write_text(body)
                executable.chmod(0o700)
            body = SCRIPT.read_text()
            body = body.replace('/opt/gamja-backup/postgres/daily/livingcost-2026-10-06T151322Z.dump', str(backup))
            body = body.replace('/opt/livingcost/releases/templates-8c4e1282614a99c1654abdac0b3618ddd998d231', str(release))
            body = body.replace('for directory in /opt/livingcost /opt/livingcost/releases "$release";',
                                'for directory in "$release";')
            body = body.replace('f1e9ebe963ce87105fab8bbfded3bc1bab42e3669255454484afacdad38e0abd',
                                hashlib.sha256(backup.read_bytes()).hexdigest())
            env = dict(os.environ, PATH=str(binpath) + os.pathsep + os.environ['PATH'],
                       FAKE_ROOT=str(root), FAKE_MODE=mode)
            # Fixed UUID only in the synthetic script; real helper uses OS UUID.
            body = body.replace('id="$(cat /proc/sys/kernel/random/uuid)"', 'id=synthetic-owned-id')
            result = subprocess.run(['bash'], input=body, text=True, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
            statepath = root / 'state.json'
            state = json.loads(statepath.read_text()) if statepath.exists() else {}
            eventpath = root / 'events.jsonl'
            events = [json.loads(x) for x in eventpath.read_text().splitlines()] if eventpath.exists() else []
            receipts = list(release.glob('restore-proof-*/receipt.txt'))
            receipt = receipts[0].read_text() if receipts else ''
            complete = 'proof_complete=true' in receipt or 'Restore proof receipt:' in result.stdout
            diagnostics = {p.name: p.read_text() for p in release.glob('restore-proof-*/*.std*') if p.is_file()}
            modes = {p.name: p.stat().st_mode & 0o777 for p in release.glob('restore-proof-*/*') if p.is_file()}
            return result, state, events, complete, diagnostics, modes

    def assert_scoped_removal(self, events):
        removals = [e for e in events if e[0]=='rm']
        self.assertTrue(removals)
        self.assertTrue(all(e == ['rm', '-f', '-v', 'lcm-restore-proof-synthetic-owned-id'] for e in removals))

    def test_success_awaits_private_diagnostics_and_cleanup(self):
        result, state, events, complete, diagnostics, modes = self.exercise('success')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(complete)
        self.assertFalse(state['present'])
        self.assert_scoped_removal(events)
        self.assertIn('synthetic restore diagnostic', diagnostics['restore.stdout'])
        self.assertIn('synthetic stderr', diagnostics['restore.stderr'])
        self.assertIn('COMMIT', diagnostics['migration.stdout'])
        self.assertTrue(all(mode == 0o600 for mode in modes.values()))
        self.assertNotIn('synthetic stderr', result.stdout)

    def test_failed_startup_still_removes_owned_created_container(self):
        result, state, events, complete, _, _ = self.exercise('startup_failure')
        self.assertEqual(result.returncode, 42)
        self.assertFalse(state['present'])
        self.assert_scoped_removal(events)
        self.assertFalse(complete)

    def test_wrong_owner_preserved_even_after_failed_startup(self):
        result, state, events, complete, _, _ = self.exercise('wrong_owner')
        self.assertEqual(result.returncode, 42)
        self.assertTrue(state['present'])
        self.assertFalse(any(e[0]=='rm' for e in events))
        self.assertFalse(complete)

    def test_diagnostic_writer_failures_propagate_and_cleanup(self):
        for mode, status in [('restore_writer_failure',73), ('migration_writer_failure',74), ('stderr_open_failure',None)]:
            with self.subTest(mode=mode):
                result, state, events, complete, _, _ = self.exercise(mode)
                if status is None:
                    self.assertNotEqual(result.returncode, 0)
                else:
                    self.assertEqual(result.returncode, status)
                self.assertFalse(state['present'])
                self.assert_scoped_removal(events)
                self.assertFalse(complete)
                if mode != 'migration_writer_failure':
                    self.assertFalse(any('pg_restore' in e for e in events))

    def test_restore_failure_is_not_masked(self):
        result, state, events, complete, _, _ = self.exercise('restore_failure')
        self.assertEqual(result.returncode, 43)
        self.assertFalse(state['present'])
        self.assertFalse(complete)

    def test_cleanup_failure_never_completes_proof(self):
        result, state, events, complete, _, _ = self.exercise('cleanup_failure')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(state['present'])
        self.assert_scoped_removal(events)
        self.assertFalse(complete)

    def test_cleanup_failure_preserves_original_startup_exit(self):
        result, state, events, complete, _, _ = self.exercise('startup_and_cleanup_failure')
        self.assertEqual(result.returncode, 42)
        self.assertTrue(state['present'])
        self.assertFalse(complete)

    def test_daemon_failure_does_not_attempt_creation_or_removal(self):
        result, state, events, complete, _, _ = self.exercise('daemon_unavailable')
        self.assertEqual(result.returncode, 70)
        self.assertFalse(any(e[0] in ['run','rm'] for e in events))
        self.assertFalse(complete)

    def test_preexisting_name_is_never_armed_for_cleanup(self):
        result, state, events, complete, _, _ = self.exercise('preexisting_name')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(state['present'])
        self.assertFalse(any(e[0] in ['run','rm'] for e in events))
        self.assertFalse(complete)

    def test_failed_inspect_is_not_assumed_absent(self):
        result, state, events, complete, _, _ = self.exercise('inspect_failure')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(state['present'])
        self.assertFalse(any(e[0]=='rm' for e in events))
        self.assertFalse(complete)


if __name__ == '__main__':
    unittest.main()
