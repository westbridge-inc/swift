# UXR WORK REGISTER — one [~] per writer

FOUNDER ORDER 08-23: everything organized in ONE queue; load shared with
Codex (gpt-5.6-sol ultra). FOUNDER DECISION: web storefront IS built with
Gluestack (recommendation to the contrary was made once and overruled).

## Claude lane (this worktree — one [~] at a time)
| ID | Wave | Screen/area | Task | Status | Proof |
|---|---|---|---|---|---|
| UXR-W-001 | W1 | REPORT-028 tail | F-028-17 + F-028-18 + F-028-15 → S-count 0 | [x] | PR #722 MERGED |
| UXR-W-007 | W1 | Web cart (S0) | WR-001 CONFIRMED: `setCartAddress(addrId).catch(()=>{})` swallows → checkout ships to stale/default. Fix: let it throw; outer catch renders | [x] | PR #723 MERGED |
| UXR-W-008 | W1 | Taxi safety (S1↓) | WR-006 DOWNGRADED: sweep DOES escalate unanswered check-ins to SOS at deadline (guardian.service:690). Residual: failed NEED_HELP send is silent+delayed — honest failure + retry | [x] | PR #726 MERGED |
| UXR-W-009 | W1 | Mobile pay (S2↓) | WR-008 DOWNGRADED: persistent "Pay business with MMG" button = durable manual path. Residual: opener false gives no feedback at any call site | [x] | PR #727 MERGED |
| UXR-W-010 | W1 | Admin money (S0) | WR-002 CONFIRMED: console sends no Idempotency-Key; recordTopUp comment says that = "opted out of dedup" → double-tap double-credits. Fix: UUID per action reused on retry + visible error | [x] | PR #725 MERGED |
| UXR-W-011 | W1 | Admin money (S1↓) | WR-003 PARTIAL: server already digest-honest (SWIFT-031) + CAS guard. Residual: admin UI copy "once the money has moved" implies a payout rail that intentionally doesn't exist — align copy/semantics | [x] | PR #729 MERGED |
| UXR-W-012 | W1 | Admin money (S1↓) | WR-005 LARGELY OVERTURNED: MMG refund fail-closes 409 (REPORT-008 F-03, LB-019 pending). Residual: admin swallows the 409 — codex MutationError covers order detail; extend to list page | [ ] | verified 08-23 |
| UXR-W-013 | W1 | Admin money (S1) | WR-004 PARTIAL: markClaimPaid is CAS (no double-pay) but paymentRef optional → PAID with zero evidence. Fix: require reference server+UI | [~] | verified 08-23 |
| UXR-W-014 | W2 | Cross-client | REPORT-029 S1/S2 tail worst-first (TOP-20 ranks 8–20, then WR-021..051 + VG rows) | [ ] | — |
| UXR-W-006 | W4 | Android | dev-client bundle load → 5-flow smoke → findings pass | [x] | SMOKE PASSED 08-23: role picker · guest browse+item · OTP auth e2e · authed Home+grid · all 4 tabs; F-272 logged |
| UXR-W-002 | W3 | Store/product | hero elevation (flow 3) | [ ] | — |
| UXR-W-003 | W3 | Vendor kitchen | first-run/empty state (G3) | [ ] | — |
| UXR-W-004 | W2 | Earner dark | F-270 decision | [ ] | — |
| UXR-W-005 | W2 | Kit | teeth+RideSheet deletion → FG-2 candidates list | [ ] | — |

REPORT-029 doctrine note: findings are STATIC (audited main@6337404; #721 delta read,
no client-surface change). Each S0 gets its own hostile re-verification against the
live tree before any edit (G1-grep-is-a-lead law; READ THE SCREEN). Money/safety
items ship one per PR, never batched.

## Codex lanes (own worktrees off origin/main; NEVER my tree; hostile review before merge)
| Lane | Task file | Output | Status |
|---|---|---|---|
| uxr-census (audit) | TASK-UXR-CENSUS.md | REPORT-029 DELIVERED 08-23 01:19 — 144 surfaces, WR-001..051, VG-001..016, TOP-20; harvested into W-007..W-014 | delivered |
| web-gluestack (build) | TASK-WEB-GLUESTACK.md | REPORT-030 + ~/swift-codex-web-gluestack | RUNNING (into e2e/playwright config) |
| admin-tests (build) | TASK-ADMIN-TESTS.md | REPORT-031 STRANDED at ~/swift-codex-admin-tests/apps/admin/REPORT-031-admin-tests.md (sandbox blocked commit + inbox copy); changes live in that working tree, uncommitted — hostile review pending | done, unharvested |

## Then (both lanes converge)
Harvest REPORT-029/030/031 worst-first → W6 sweep (copy/motion/a11y/VG-zero) → W7 certify.
