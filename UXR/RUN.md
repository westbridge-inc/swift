# UXR-1 RUN — bootstrap 2026-08-23

**Governing doc:** `swift-standard/UIUX-REFINEMENT.md` (UXR-1, founder-supplied 08-23).
**Imported truth (per UXR-1 §0.5 — "import, don't redo"):**
- Screen ledger → `swift-standard/ELV2/SCREEN_LEDGER.md` + the re-score in `swift-standard/UIUX-AUDIT-2026-08-23.md` (14 flows, craft/substance-gate).
- Findings → `swift-standard/ELV2/FINDINGS.md` (F-001…F-270 lineage; UXR-F numbering continues from there).
- Baselines → `UXR/BASELINES/` seeded with today's device screenshots (iOS 4 tabs, admin headless, Android first boot).
- Substance gate → `swift-standard/ELV2/RUBRIC-AMENDMENT-SUBSTANCE-GATE.md` (G1/G2/G3) — UXR-1's TRUTH scorecard items 5–8 are the same doctrine; both apply.

## Run adaptations (recorded per Law 1 — code/reality outranks the doc)
1. **Branch/loop:** work continues on the established single-writer worktree
   (`~/swift-location-wt`, branch `fix/location-permission-in-context`) with the
   proven ship loop: one item → gates → PR → CI → merge-on-green. This satisfies
   UXR-1 §9's atomic-commit + firewall intent; `pre-uxr1` tag set on main.
2. **Stack findings (doc assumed ≠ code reality — recorded, not "fixed"):**
   UXR-F-001 · doc says Centrifugo → code uses **Socket.IO** (realtime honesty
   checks apply to Socket.IO reconnect semantics).
   UXR-F-002 · doc says Novu → code uses a **custom NotificationService**.
   UXR-F-003 · doc says AdminJS → admin is a **custom Next.js app** (just
   re-skinned Swift-dark, #718).
   UXR-F-004 · doc says Typesense/PostHog/Turbo → verify each against
   package.json before ever citing them in evidence.
3. **CI = part of the firewall.** B-scenario equivalents live in the API vitest
   suites (2,300+ tests) + ELV2 baseline scripts (b14-safety-honest etc.);
   full B1–B14 device runs are scheduled per wave exit, not per merge.
4. **PILOT_DATA: RADIOACTIVE** honoured — matches the standing rule
   (founder's driver account + protected simulator already radioactive).
5. **ATTRIBUTION: WESTBRIDGE_ONLY** — already law; commits are
   `westbridge-inc <westbridge-inc@users.noreply.github.com>`.

## Environment truth (t0)
- HEAD (main): post-#720. Node 20.19.6 via PATH. pnpm workspace.
- Dev stack: Docker (swift-postgres/redis/search) — does NOT auto-start on
  Docker restart. API :3000 · admin :3001 · Metro :8081 (serves iOS + Android;
  android bundle entry = /apps/mobile/index.bundle).
- Devices: iPhone 17 sim (E0719B54…), Android emulator `swift-test`
  (hand-written AVD; brew avdmanager broken), headless Chrome via
  ~/.cache/puppeteer for web/admin.
