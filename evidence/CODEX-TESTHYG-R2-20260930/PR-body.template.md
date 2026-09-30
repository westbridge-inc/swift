## Result and scope

Revision2 implements all five accepted AX395 test-isolation repairs. Exact publication head: `{{HEAD_SHA}}`. History at `5f026c47b405083d6f8d3b91751d995061761af9` is preserved; current base is `5cb7279971ddf2ca91c69ed6984ad3ae40c1c950`. Changes are limited to `apps/api/src/__tests__/**` and `evidence/CODEX-TESTHYG-R2-20260930`.

Local execution uses the existing `swift_test_hyg` database (Postgres 5434, cluster `7619037970487636006`), Redis 6382 db9, and the private Prisma client/config. Donor symlinks are preserved. No database reset/drop, dependency install or production change occurred.

## Accepted cause, repair and proof

| Finding | Cause and fix | Deterministic pre-fix red | Final mutation and restored green |
| --- | --- | --- | --- |
| AX395-1: mover-linked peer orders | Cleanup missed rider/driver order links and removed riders before locks. Guard all four parent links, lock users/vendors/riders/drivers, recheck, then delete all fixture dependents and parents transactionally. Production audit purge batches join the same transaction through a test-only adapter. | Replay published helper with peer RIDER/DRIVER orders: 2 failures, cleanup resolved instead of rejecting. Whole peer order/profile and owned alert must survive refusal. | Omit only the locked recheck: both deterministic post-preflight insertions fail the rejection assertion. Exact source hash restored; 2 tests pass. |
| AX395-2: order-hold cleanup race | Empty preflight and vendor deletion were separate. One transaction now holds parent locks through recheck and all cleanup; recorded message IDs replace broad message discovery. | Independent client inserts after the preflight snapshot: cleanup resolved instead of rejecting, 1 failed. Regression requires the full peer order/vendor and owned order/alert unchanged. | Remove locked recheck: 1 failed at rejection; exact source restored; 1 passed. |
| AX395-3: VEND04 peer alerts | Before/after census claimed new peer alerts sharing subject/recipient. Record successful create IDs and bulk RETURNING IDs; skipped/failed writes never confer ownership. Purge exact IDs in the guarded cleanup transaction. | New peer alert inserted after setup was deleted: expected full row, received null, 1 failed. | Shared subject/recipient cleanup again deletes peer alert: 1 failed; exact source restored; 1 passed. Regression also covers skipped and failed duplicates. |
| AX395-4: shared capacity configuration | Highest-version default-tenant override affected peer configuration and raced version selection. Intercept only this client's existing capacity config read; the real dispatch/claim path runs and asserts traversal. | Startup adds an extra shared capacity row: exact shared-config snapshot fails, 1 failed. Private tenant's real capacity-1 reader and independent shared-default reader are checked. | Reintroduce shared DB override: 1 failed on extra row; delete only mutant row, restore exact source; 1 passed. Final harness writes no shared capacity row. |
| AX395-5: midnight clock drift | Awaited dashboard reads could cross UTC/Guyana midnight after computing counts. Freeze Date only per journey/assertion window, keeping real timers alive. | Explicit UTC and Guyana transitions between successive reads: 2 failed, tierToday/today changed from 1 to 0. | Bypass Date control: both exact assertions fail; exact source restored; 2 passed. The next frozen window recomputes exact post-boundary counts. |

Proof commands, outputs, mutation patches, landed/traversed/restored SHA256 receipts and source fingerprints are committed in the evidence directory. Failed setup attempts and the first masked teardown failure are retained and are not counted as valid red proof.

## Final verification and remaining gates

- Three consecutive runs on the same long-lived database, without reset: each **10 files / 69 tests passed**. Includes all eight fixed files, new cleanup regression, and the audit append-only boundary suite. Run IDs: `472dc281-94bf-46f0-b978-b0092b3a95ec`, `88fbb919-e30b-4c9a-a883-b4bd1a5997a7`, `d0d3be7b-4443-4fe7-bc60-93320af940af`.
- API types through `heavy.sh` with the private config and established 6 GiB heap: exit 0. ESLint on all 14 changed test/helper files: exit 0. `git diff --check`: exit 0.
- **Whole-golden repetition HELD locally:** disk check before the first full run returned **14.781 GiB**, below the owner's **15 GiB** gate. No whole-golden run was started or claimed green for revision2. **Full CI is required, including two whole-golden-folder runs on the same CI database without reset.**
- Independent Astra exact-head review and additional DeepSeek audit are coordinator-queued. This writer did not self-review or spawn a reviewer. This lane must never merge/deploy.
