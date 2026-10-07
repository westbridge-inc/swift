# audit/ — Swift evidence harness

This directory defines repeatable scanner coverage for Swift's actual stack:
Fastify, Prisma/PostgreSQL, Socket.IO, BullMQ/Valkey, React Native/Expo,
Next.js, Tauri, Turborepo, OSRM, VROOM, Nominatim, and Meilisearch.

Scanner output is evidence input, not a security certificate or a launch verdict.
Every reported issue still requires source inspection, a `path:line` citation, and
reproduction. A clean scanner run does not prove that a business flow works.

## Prerequisite check

```sh
bash audit/install.sh
```

The script only reports installed versions. It never downloads packages, uses
`sudo`, modifies Homebrew, or runs an unpinned `npx` package.

## Run

```sh
bash audit/run.sh
AUDIT_QUICK=1 bash audit/run.sh
```

Results are local and ignored under `audit/out/`. A stage is marked `SKIPPED`
when its binary or the repository's installed dependencies are unavailable;
skipped coverage must never be reported as passing.

Database checks are disabled by default. They may run only on the lane-assigned,
isolated database using all three explicit inputs:

```sh
AUDIT_DB_APPROVED=1 \
AUDIT_ALLOWED_DATABASE=swift_test3 \
AUDIT_DATABASE_URL='postgresql://…@127.0.0.1:5434/swift_test3' \
bash audit/run.sh
```

The runner rejects shared database names, non-loopback hosts, non-5434 ports,
and any database whose parsed name does not exactly equal
`AUDIT_ALLOWED_DATABASE`. The current Codex product lane has no database
assignment, so database stages remain skipped until coordination assigns one.

Never put connection strings, scanner findings containing secrets, customer PII,
or internal audit registers into Git. `gitleaks` output is redacted and
TruffleHog output is reduced to metadata that cannot contain the raw credential.

## Coverage

| File | Purpose |
|---|---|
| `install.sh` | check required and optional scanner versions without installing |
| `run.sh` | run deterministic scanner stages and record pass/fail/skip evidence |
| `rules/swift.yml` | local Swift-specific Semgrep rules |
| `db-checks.sql` | read-only PostgreSQL/RLS diagnostics for an assigned test database |
| `AUDIT-RUNNER.md` | human-review coverage manifest, evidence rules, and remediation gates |

The human review covers security, tenant isolation, money, order/dispatch state
machines, customer/vendor/mover/taxi/courier/services flows, admin reality,
notifications/jobs/integrations, infrastructure, mobile/web parity, tests,
suppression debt, and forgotten on-disk work. Completeness is measured against
tracked-file and route/screen/query manifests—not an arbitrary finding count.
