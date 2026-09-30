Status: DELIVERED — full-golden CI and independent review pending
From: Codex GPT-6.1 Sol
To: Coordinator
Re: #1401 revision2, CODEX-TESTHYG-R2-20260930

Sole writer on test/hygiene-run-isolation. Initial working tree clean; HEAD and published PR head 5f026c47b405083d6f8d3b91751d995061761af9. Owner explicitly authorizes this existing lane. No lane registration or review-queue changes.

Read AX395 raw audit and coordinator verdict; all five accepted findings will receive deterministic regression and restored mutation evidence. Scope: tests and this evidence folder only. No production edit, database reset, dependency install, donor symlink mutation, simulator or external personal source access.

Initial command: gitleaks git --log-opts 'origin/main..HEAD' --no-banner --redact=100
Actual output: 2 commits scanned; ~25257 bytes scanned; no leaks found; exit 0.

Local cluster probe: run.py cluster probe. Actual output: swift_test_hyg / 7619037970487636006, exit 0 (cluster.log). Redis command: redis-cli -p 6382 -n 9 PING; actual output PONG.

Implementation checkpoint: all five repairs passed full directly affected test paths (4 files / 37 tests, then GOLD-3 / 6 tests). API types passed after correcting the regression fixture's union return annotation; lint passed all 14 changed test/helper paths. Fresh origin/main remains 5cb7279971ddf2ca91c69ed6984ad3ae40c1c950 and is already an ancestor; no merge or history change required.

Deterministic pre-fix reds recorded: rider cleanup accepted peer assignment; order-hold cleanup accepted late peer order; VEND04 deleted new peer alert; GOLD-3 added a shared capacity row; both midnight cases changed exact counters between reads. Initial driver setup error and initial capacity-1 default assumption are retained as failed setup attempts, not claimed as valid red proof. Corrected regressions and additional bounded mutations supply the actual proof.

Running test-only mutations with SHA256 restoration receipts, then three affected runs (all eight original fixed files plus new regression and audit boundary suite) and two whole-golden runs on the same database without reset. Full-suite disk gate: minimum 15 GiB; no deletion permitted. Independent review remains coordinator-owned; no reviewer spawned or merge requested.

Final local verification: affected-repeat-1/2/3 each 10 files / 69 tests passed, no reset. API types delivery exit 0; changed-files lint delivery exit 0. Full golden repeats were not started because the disk gate measured 14.781 GiB; both repetitions require CI on the same database without reset. All five valid mutation cases have landed/traversed/restored hash receipts and immediate restored greens. The first late-mutation teardown masking attempt is retained and explicitly excluded as proof. No real product defect blocked implementation.

Implementation is ready for gated publication of the existing PR. Review remains coordinator-owned; no self-review, reviewer spawn, merge or deployment. Exact publication SHA is filled into the existing PR body after commit; tested source fingerprints are committed in test-source-sha256.txt.
