# Optional central marketing aggregates

This pipeline is **off by default**. Local product analytics stay on the device;
central metrics require separate browser consent. Counts measure submitted events,
**not unique people, conversion, or retention**. Public clients can forge events,
so these aggregates are directional evidence, not an audited source of truth.

## Wire and export contract

`POST ${API_BASE_PATH}/marketing/events` accepts only a JSON object with one `event`
property. No account, workspace, financial value, timestamp, identifier, campaign,
URL, query, referrer, IP, or user-agent belongs in this payload or aggregate file.
The POST is public and requires no authentication; the browser omits credentials.
There is no public or ordinary-JWT aggregate read endpoint.
The server cannot prove browser consent, personal context, or deduplication from
this deliberately minimal payload. Those safeguards apply to the shipped browser
client; endpoint limits constrain, but do not authenticate, public submissions.

Allowed event names:

- `personal_cost_saved`: a **validated Quick Add** with a name and explicit parsed
  amount (including an explicitly entered zero) successfully persists a new row.
  Empty Add placeholders and ordinary manual registration do not emit or consume
  this milestone. Duplicate, restore, and import actions do not emit it either.
  This is narrower than all cost registrations and is not proof of payment.
- `personal_billing_date_saved`: an explicit edit changes a row's anchor date to
  a valid calendar date and the saved snapshot contains that date. Clearing the
  date, card settlement settings, and unchanged values do not emit it.
- `personal_renewal_decision_saved`: an explicit edit changes renewal status to
  `keep`, `cancel-planned`, `change-review`, or `completed`, and the saved snapshot
  contains that status. `unreviewed` is not a decision. This is a recorded intention
  or status, not proof of cancellation, renewal, or savings.

Attribution is deliberately omitted. The API assigns the UTC date at receipt.
The private file is the export format, version 1:

```json
{"version":1,"days":[{"date":"2026-10-05","counts":{"personal_cost_saved":1}}]}
```

Only the three event keys above are allowed in `counts`, with bounded nonnegative
integer values. Retention uses calendar age: today minus 89 UTC days through today,
not merely the most recent 90 populated entries. Missing events
have zero count. Access requires filesystem/operator access, not an application JWT.

## Consent and measurement interpretation

Central consent is separate from local analytics. Global Privacy Control and Do
Not Track override opt-in. Enabling consent does not scan existing records or send
historical milestones. Sample data and all server-linked profiles (including
shared workspaces and linked profiles after logout) are excluded conservatively.
Only successful personal save actions after opt-in can trigger a milestone.
An eligible action must originate from an explicit user edit and complete local
persistence. Hydration, fetched snapshots, imports, and optimistic UI changes are
not save evidence. These milestones do not attest to payment or server sync.

Deduplication is once per event name, a browser-local convenience within the current consent period,
not a server identity or a unique-person metric. Clearing browser storage, using
another browser, or starting another consent period may permit another event.
Delivery failures may undercount; forged submissions may overcount. Do not label
ratios from these counts as conversion or retention. Disabling consent prevents
future sends and drops pending local work; it cannot subtract events already
received into an anonymous total. There is no historical backfill or retry queue.
Failed local persistence drops the action's signal even if the financial save is
retried later. Dedup markers are a fixed three local keys and never transmitted.
Simultaneous tabs may race on localStorage; deduplication is not an identity or
exactly-once guarantee. Storage access failures deny transmission. Revocation
writes an OFF tombstone before removing consent: if removal fails independently,
OFF remains effective in other tabs and after reload. If shared storage cannot be
written **or** removed, a sessionStorage denial protects this tab across reloads
when available; a fixed browser-local BroadcastChannel message best-effort stops
already-open tabs. The UI explicitly warns when shared revocation cannot be
verified. If every persistence mechanism fails, only the current in-memory denial
is guaranteed: close other tabs and clear site storage or use GPC/DNT. Do not claim
durable global revocation in that state. Every dispatch also requires successfully
writing its dedup marker. GPC/DNT is checked again immediately before send.

Stable browser-test selector: native checkbox `[data-testid="marketing-consent"]`
on the main page. The independent browser harness intercepts all API mutations.

## Collector limits and responses

- Successful receipt: **202** with `{"ok":true}` and `Cache-Control: no-store`.
  Valid GPC/DNT opt-out requests receive the same response without incrementing.
- Disabled or missing/relative file configuration: route absent (**404**).
- Invalid payload or any query string: **400**. Unsupported media type: **415**.
- Body limit: **256 bytes**, rejected with **413** before application processing.
- Global process rate budget: **120 requests / 60 seconds**, **429** on exhaustion.
  It uses one constant limiter key, not IP/user-agent identifiers. One client can
  exhaust this shared budget; this is an intentional privacy/availability tradeoff.
- Maximum **5,000** per event per UTC day; **10,000** total events per UTC day.
  At most **32** queued/in-flight writes and **65,536 bytes** per aggregate file.
  Capacity exhaustion returns **507**; rejected events do not increment counts.
- Corrupt/unreadable/unwritable storage: collection fails closed (**503**) without
  replacing corrupt data or preventing financial API startup. Error notices carry
  only fixed reason codes, never request values or file contents.
  The failure stays latched until the operator stops the writer, repairs storage,
  and restarts it. There is no automatic recovery or replay of rejected events.

The queue serializes the full read/validate/prune/increment/publish cycle. The
writer syncs file data before atomic replacement and syncs its directory afterward.
A failure after replacement may leave a committed count despite a 503; the browser
does not retry. Canonical exports are sorted by date, omit zero counts/empty days,
and contain no more than 90 retained calendar dates.
Retention runs at startup and before writes; idle checks run every 60 seconds
after five minutes without a write. Newly expired days can remain until that next
cleanup. Stopped, disabled, or failed collectors require operator retention work.
Only one fixed sibling `<file>.tmp` can remain after a crash. Startup removes a
safe private regular orphan even when the published aggregate is empty; unsafe
temporary slots (including symlinks) fail closed for operator inspection.

## Deployment handoff

Explicit API environment configuration is required:

```text
MARKETING_METRICS_ENABLED=true
MARKETING_METRICS_FILE=/var/lib/lcm-marketing/aggregate.json
```

The static frontend also needs its existing API base at **build time**:

```text
NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1
```

No frontend API base means no transmission. The base must have no credentials,
query string, or fragment. The browser uses `credentials: "omit"` and
`referrerPolicy: "no-referrer"`, with no authentication headers. API prefix and
frontend base must agree; for the example above set the API's existing
`API_BASE_PATH=/living-cost-manager/v1` as appropriate for the gateway routing.

The path above is a proposed container path, not an existing provisioned mount.
The deployment owner must mount a private writable directory from the existing
OCI persistent volume at that directory. No database migration is involved.
Verify the actual mount and runtime UID/GID before activation; a writable path
alone does not prove that storage survives container replacement. Check volume
snapshots as well as directory-level backup jobs against the retention policy.
Mount the **directory**, not an individual file: atomic replacement uses a sibling
temporary file on the same filesystem. Use a local POSIX filesystem with atomic
rename and fsync support, restricted to the API runtime user; never put it beneath
a web/static directory. Run exactly one API process/writer for this file, including
during rollouts: no cluster workers, replicas, overlapping old/new containers, or
external writers. Copy only the atomically published JSON for private exports,
never sibling temporary files left by an interrupted write. Reject unsupported
export versions rather than merging them into version 1 data.
Concurrent writes inside the process must serialize the complete update and atomic
publication; one process alone is insufficient to prevent lost increments.
The application creates directories with mode `0700` and aggregate/temp files with
mode `0600`. Existing configured directories must be real directories owned by
the current API UID with exactly `0700`; aggregate files must be current-UID-owned,
regular, single-link files with exactly `0600`. Symlinks and unsafe permissions are
rejected at startup and rechecked on access, without chmod or overwriting evidence.
Check ownership against the deployed runtime UID, not a presumed UID. A collector
that becomes unsafe fails closed and requires operator repair and restart.

The analytics service must not log request bodies, raw queries, identifying headers,
IP, user-agent, or referrer for marketing requests, including rejected requests.
Verify Fastify route logging suppression and that API instrumentation/APM does not
dump these requests. Verify Nginx does not dump bodies or raw query strings for
this route; an exact-location `access_log off` exception is an optional approach,
without changing broader security logging. Do not weaken existing infrastructure
security logs or request broader Cloudflare permissions to enable this feature.

An anonymous event payload does **not** mean anonymous transport. Existing
infrastructure, including Cloudflare security systems, may process network metadata.
This implementation adds no analytics identifier logging and cannot promise the
absence of metadata processing in those independent systems. Record which logging
settings were actually verified; unavailable Cloudflare analytics metadata (403)
is not proof that such processing is absent.

Use the existing API base path and allowed frontend CORS origins. Keep the file
out of general backups or apply the same 90-day deletion policy to backups and
private exports. When the process is stopped/disabled, an operator must remove
expired data: an inactive process cannot perform retention cleanup.

These are deployment prerequisites, not performed changes. The coordinator must
record the environment names, process ownership, volume path, logging exceptions,
and retention/backup policy in `gamja-ops` before activation, per the repository
operations policy. No deployment, registry modification, or volume provisioning is
included in this code change.
