# Templates credential exposure incident — 2026-10-07

- Receipt timestamp UTC: 2026-10-06T16:04:25.000977+00:00
- Reviewer reported actual credential exposure in `/Users/sanghyun/docs/templates-frontend-repair-20261007.md`, line 47, previously mode 0644. Main changed mode to 0600 before cleanup.
- Cleanup replaced exact designated assignment value throughout that document with `<REDACTED_REQUIRES_OWNER_ROTATION>`, preserving other content and mode 0600. Verification: marker present. Original helper timed out during overly broad temporary-directory scan AFTER writing redaction; original occurrence count was not captured.
- Initial exact-value scan incomplete; no claim of exhaustive absence. Follow-up bounded scan examines only local markdown docs and top-level task-prefixed `lcm-*.log/md/py/sh` evidence under approved OpenCode temporary directory, max 10 MB per file. Credential-shaped Cloudflare assignment candidates are held only in process memory. No values/fingerprints emitted. Candidates cannot now be conclusively linked to the redacted original.
- Follow-up scanned files: 57; candidate-bearing records: 0. These copies restricted to 0600; contents preserved (no protocol/conversation deletion).
- `/Users/sanghyun/docs` is not inside a Git working tree. Original LCM and gamja-ops working trees contain pre-existing changes and are preserved.
- Token validity NOT tested; revocation, rotation, creation and deployment NOT performed. Owner approval for revocation/rotation PENDING. Redaction does not invalidate exposed credentials.
- Git-history/conversation/database exposure scan remains pending; no rewrite or deletion performed. Independent review pending.
