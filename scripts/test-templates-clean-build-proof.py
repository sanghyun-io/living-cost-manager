import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('proof', Path(__file__).with_name('templates-clean-build-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class ProofTests(unittest.TestCase):
    def test_digest(self):
        self.assertEqual(proof.sha(b''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

    def test_invalid_sha_rejected_before_side_effects(self):
        with patch.object(proof.sys, 'argv', ['proof', 'main']), patch.object(proof.subprocess, 'check_output') as run:
            with self.assertRaises(SystemExit):
                proof.main()
            run.assert_not_called()

    def test_public_fetch_is_read_only_and_bounded(self):
        response = subprocess.CompletedProcess([], 0, stdout=b'asset', stderr=b'')
        with patch.object(proof.subprocess, 'run', return_value=response) as run:
            self.assertEqual(proof.public_bytes(proof.PUBLIC_BASE + '/'), b'asset')
            args = run.call_args.args[0]
            self.assertIn('--max-time', args)
            self.assertNotIn('--data', args)
            self.assertNotIn('--header', args)
            self.assertEqual(args[1], '--disable')

    def test_missing_or_failed_comparison_cannot_pass(self):
        self.assertFalse(proof.equivalence_passes({}))
        self.assertFalse(proof.equivalence_passes({'all_compared_public_js_match': False}))
        self.assertFalse(proof.equivalence_passes({'all_compared_public_js_match': True, 'public_route_errors': ['/']}))
        self.assertTrue(proof.equivalence_passes({'all_compared_public_js_match': True}))

    def test_failure_does_not_return_response_body(self):
        response = subprocess.CompletedProcess([], 22, stdout=b'private error body', stderr=b'private diagnostic')
        with patch.object(proof.subprocess, 'run', return_value=response):
            with self.assertRaisesRegex(RuntimeError, '^Public fetch failed$'):
                proof.public_bytes(proof.PUBLIC_BASE + '/')


if __name__ == '__main__':
    unittest.main()
