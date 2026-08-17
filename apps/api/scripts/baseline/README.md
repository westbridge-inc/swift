# ELV-1 baseline scenarios (A10) — the no-regression firewall

Scripted end-to-end proofs run against the LIVE local rig (API :3000 + dev DB :5434),
with server-side evidence, per `swift-standard/ELEVATION-PROTOCOL.md` Part I A10.
Results and evidence paths are recorded in `swift-standard/elevation/BASELINE.md`.

## Laws
- **Synthetic actors only (INV-14).** Every script creates and uses `ELV1-`-marked
  actors; existing vendors/customers/orders are never written. A script that needs a
  fixture makes its own, idempotently.
- **Real flows where feasible**: customers sign up through the real OTP flow (the rig's
  dev bypass); vendor/back-office fixtures may be seeded directly when the onboarding
  round-trip is its own scenario (B12).
- **Evidence or it didn't happen**: scripts print timestamped assertions and hard-fail;
  runs are tee'd to `swift-standard/elevation/audit/b<N>-run<K>.log`.
- Scenarios are read-mostly probes plus their own synthetic writes. They must be safe
  to re-run (idempotent rosters, self-cleanup where state would poison reruns).

## Running
```bash
cd apps/api
PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH \
DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
npx tsx scripts/baseline/<scenario>.ts
```

## Scenarios
| Script | Covers | Status |
|---|---|---|
| `b6-hold-race.ts` | B6 — double-tap exactly-once creation · vendor-blind hold · cancel-in-hold sticks · honest expiry surfaces the order | first run 2026-08-18 |
| (next) | B2 MMG obligation · B7 no-availability honesty · B11 cross-tenant hostility (needs the tenant-B roster) · B3/B4/B5/B9/B10/B12 | pending |

B1 (canonical cash delivery) has a banked LIVE run from 2026-08-15
(`swift-standard/audit/EVIDENCE/e2e-live-dispatch-2026-08-15.md`) — its re-run on
current bytes rides the same harness once the rider legs are scripted.
