# UXR PROGRESS (append-only)
- [x] F-265..269 → PR #720 MERGED
- [x] F-028-20 + UXR bootstrap → PR #721 MERGED
- [~] UXR-W-001 IN FLIGHT (F-028-17 ✅ edited: URL-class guard truth-checked 5/5, resilient+verified restore, trust-ratchet restore, /health states dispatch tuning + b9 pins to it — UNCOMMITTED in worktree; F-028-18 half-done: fare-step canAdjustFare(MIN_ADJUST_SECONDS=10) added ✅, toast-duration queuedAhead param ✅; REMAINING: wire toast.tsx push() → pass queuedAhead=visible SR toasts + hold timer until initial SR detection resolves; code-input digit T gets maxFontSizeMultiplier={2} to match box cap; gate MoverHome slider on canAdjustFare(offer.expiresInSeconds) with honest "No time to adjust — accept at $X" line; then F-028-15 (S3) → one PR)
- Codex lanes RUNNING: uxr-census (PID 84119) · web-gluestack (84489) · admin-tests (85019) → REPORTs 029/030/031 in ~/swift-coordination/inbox-claude/
- Android: emulator relaunch + bundle warm in bg task b88cqwfc7 (check /tmp/ab.js size; then adb reverse + reload app)
2026-08-23 ~05:20 · CONTEXT CLEAR CHECKPOINT — UXR-W-001 [~] F-028-15 MID-EDIT: statement.ts sign side DONE on disk (signStatementTokenV1 + v=2 URL); NEXT EDIT = statement.routes.ts dual-verify (v param branch) + test; then ONE commit F-028-17+18+15. Full continuation state in memory/project_swift_run_state.md §NEXT UP. 10 files modified, mobile 409 green, eslint clean.
- [x] UXR-W-001 gates GREEN (API 2283+known outbox env defect; tenancy residue cleaned; statements 16/16 w/ 3 new F-028-15 pins; mobile 409/409, tsc+eslint clean both) → shipping ONE commit F-028-17+18+15
- [x] UXR-W-001 CLOSED: PR #722 MERGED (F-028-17+18+15) — REPORT-028 FULLY HARVESTED
- [x] REPORT-029 harvested into register: W-007..W-014; all 7 S0s hostile-verified (WR-001+WR-002 CONFIRMED; WR-006/008/003/005 downgraded with residuals recorded; WR-004 evidence gap)
- [x] REPORT-031 preserved: codex/admin-tests committed locally 6093ee8 (12 pass + 2 honest it.fails); blockers: lockfile regen, CI test cmd, MutationError restyle
- [~] UXR-W-007 ACTIVE: WR-001 fix (delivery checkout blocks on failed address set)
- [x] UXR-W-007 CLOSED: PR #723 MERGED (WR-001 delivery checkout blocks on failed address set)
- [~] QR deep-links: app.config associatedDomains+intentFilters (swiftgy.com), web well-known AASA/assetlinks (404-honest until founder env), /s/:code prod proxy rewrite — shipping as its own PR
- [x] QR deep-links SHIPPED: PR #724 MERGED (associatedDomains + intentFilters + AASA/assetlinks 404-honest + /s/:code prod proxy). Founder inputs open: Team ID, keystore SHA-256, VERCEL_TOKEN. iOS interception rides the F-254 native rebuild
- [~] UXR-W-010 ACTIVE: WR-002 admin top-up idempotency (reference-derived key + honest failure)
- [x] UXR-W-010 CLOSED: PR #725 MERGED (WR-002 top-up idempotency + visible money-mutation failures)
- [~] UXR-W-008 ACTIVE: WR-006 residual (NEED_HELP/OK honest send failure, TaxiScreen)
