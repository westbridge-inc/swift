# DESIGN_NOTES — the working journal (design-100× Part 2)

Read this before every new flow. Plans, critique-gate revisions, tricks already
used (signatures never repeat), things tried and rejected.

---

## 2026-08-18 — HOME (register flow 1) — elevation pass 2

### Why a second pass
The founder rejected the shipped Home twice ("the UI isn't what it's supposed
to be"). Audit against the spec's own bar agreed with him:

- The header is the **hard rectangle** Part 10 explicitly forbids. The
  `GradientMasthead` wash (brand 500→600) was built for this and had **zero
  consumers** — the flat `brand[500]` block shipped instead.
- **No signature element.** The Part 10 candidates (pictogram rail / the
  header-to-content resolve shape) were never executed distinctively; the
  screen fails the critique gate ("a generic delivery-app brief would produce
  this exact screen" — it would, and did).
- **No characterful type moment.** Above the fold Home renders micro/body/label
  only; the display face never appears where the eye lands first.
- **Dead vertical rhythm** (the exact hunt item): every section is the same
  white-card weight on `surface.subtle` at uniform 2xl gaps; the promo banner
  is a white card with a stock photo — the most templated element on screen.
- The Part 2 journals and Part 13 scorecards **did not exist in the repo** —
  this file is their overdue beginning.

### Pass A

1. **Subject & job.** A Georgetown customer on a hot afternoon, phone at full
   brightness in sunlight, answering "what can I get right now" in one glance —
   food, a ride, a parcel — and reaching it in one tap.

2. **Token usage.** Everything from `@swift/ui`: masthead wash tokens
   (`color.masthead` 500→600), `brand[50/600]` tiles, `surface.base/subtle` +
   a NEW `surface.sunken` (3% brand tint on base — spec 9.1 role that was
   never minted), type via `T` variants only (`micro`, `title`, `body`,
   `label`), spacing scale only.

3. **Layout concept.** Same anatomy (header → services card → rails — the
   behavior-frozen law), but the header becomes a *place* instead of a block:
   the brand wash deepens downward (500→600) and ends in an **awning edge** —
   a shallow scalloped hem — with the services card tucked under it, so the
   overlap finally means something: goods on the shelf under the shop awning.

   ```
   ┌──────────────────────────────┐
   │  DELIVER TO ▾        🔔  ◯  │   wash 500 …
   │  Good afternoon, Devon       │   … deepening …
   │  [ 🔍 search pill 52dp ]     │   … to 600
   ╰◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡◡╯   ← the awning hem
      ┌────────────────────────┐
      │  ⛊  ⛉  ⛶  ⛍  (tiles)  │      card under the awning
   ```

4. **The signature element — "the awning."** Georgetown commerce happens under
   storefront awnings; the `shops` pictogram in our own set already draws one.
   One shallow scalloped hem (amplitude ~10dp, ~7 scallops, single color = the
   wash's end color) closes the masthead. It is drawn once as a kit component
   (`AwningEdge`) so other mastheads can inherit it, and it is the only bold
   move on the screen. No delivery app we can name owns this shape; it is ours
   because the city it serves looks like this.

5. **The type moment.** Exactly one display-face line: a time-aware greeting
   ("Good morning / Good afternoon / Good evening" + first name when signed
   in) set in `title` (Bricolage semibold) on the wash. The Deliver-to row
   becomes the eyebrow above it. Two-display-max law: one use, deliberate.

6. **Rhythm repair.** The promo + ad-bar zone sits on a `surface.sunken` band
   (grouped, quieter); `SectionHeader` gains an optional `eyebrow` (micro
   caps) that encodes something TRUE — "From your orders" over Order again,
   "Open now" over Recommended. The stock-photo promo becomes a tinted
   `brand[50]` card led by our own `orders` (receipt) pictogram — the receipt
   IS the 0%-fees story — photo removed.

7. **Motion.** One first-paint stagger on the 8 tiles (opacity + 4dp rise,
   `gentle` 320ms, ≤6+2 items, plays once, reduced-motion → none — Reanimated,
   native driver). Nothing else new; pressed states already on-mechanic.

8. **Copy (current → new).**
   | Current | New |
   |---|---|
   | (no greeting) | "Good afternoon, Devon" (time-aware, name only when signed in) |
   | "0% fees" / "No markups — pay cash on delivery." | "0% fees, always" / "Swift never marks up your order. Pay cash when it arrives." |
   | everything else | unchanged — already glossary-true |

### Critique gate (worked honestly)
Generic-brief comparison: a wash gradient + greeting is common (Grab does a
greeting); a scalloped awning hem is not — we could not name one delivery app
that owns it, and it is grounded in the subject (1.2), not in Dribbble. The
tile stagger is common but subtle and once-only. **Revision made at the gate:**
the first draft kept the promo's stock food photo "for warmth" — that is the
exact templated element the founder is reacting to; cut, replaced with the
pictogram-on-tint treatment. **Removed accessory (the mirror):** the promo
photo.

### Scorecard target (Part 13)
Hierarchy 2 · Grid 2 · Type 2 · Color 2 · States 2 · Perf 2 (stagger is
opacity/transform only) · Floor 2 · Copy 2 · Signature 2 (the awning, named) ·
Restraint 2 (photo removed, logged) → 20/20 target, graded after screenshots.

### Tried and rejected
- Header bottom as one large single arc — read as a generic "wave divider"
  (web-template tell). The repeated shallow scallop is the awning; the single
  arc is a template. Rejected.
- Greeting in `display` (28dp) — too loud over the search pill; `title` (22dp)
  holds the line. Rejected 28.
- Tinting the services card `brand[50]` — fought the tiles' own `brand[50]`
  fills; card stays `surface.base`. Rejected.

### Pass B — built + screenshot-critiqued (sim: iPhone 17 Pro, Metro live)
Round 1: 7 scallops / 10dp — confident but slightly cloud-edged. Round 2:
**9 scallops / 8dp — the keeper** (fringe rhythm, quieter). firstName guarded
against blank/whitespace. Stagger verified on refresh (not capturable in a
still). Gallery: /private/tmp/home-before.png → home-after2.png (copies in
swift-standard/audit/EVIDENCE/design/).

### Part 15 report — HOME (elevation pass 2)
```
FLOW: Home                                     SCORE: 19/20
PLAN → CRITIQUE GATE: promo stock photo cut (the most templated element);
  single-arc hem rejected as a web-template tell → the scalloped awning
SIGNATURE: the awning hem (AwningEdge — masthead wash resolves like a
  Georgetown shopfront; the services card is the shelf under it)
BEFORE/AFTER: home-before.png → home-after2.png (single device this pass —
  low-tier Android pass still owed, hence 19 not 20: Perf scored 1 unmeasured)
COPY: 2 strings rewritten (greeting added; promo title/sub)
PERF (low tier): NOT MEASURED this pass — stagger is opacity/transform-only,
  native driver, once-per-mount; hem is one static Svg path
LINT: 0 literals (fills/tints all tokens)   REGRESSION: mobile 375/375
BACKEND CALLS: identical (presentation-only; same hooks, same navigations)
INTENDED DIFF: Home only — masthead wash+hem+greeting, tile stagger, section
  eyebrows, tinted promo, sunken commercial band
REMOVED ACCESSORY: the promo's stock food photo
FOUNDER DECISIONS / BLOCKED: none
```

## Flow 13 — Vendor dashboard · stage 1 (2026-08-19)
**Pass A (from the scored register, 9/20, worst in the app):** the operator's
live queue was buried beneath eight management sections. Moves shipped:
(1) THE DOCKET RAIL — New/In-progress orders now sit directly under the
header; every queue card ends in the **DocketEdge tear-line** (registered
signature: Georgetown kitchens run on paper dockets; the card ends the way a
docket does). (2) THE SHIFT STRIP — one `surface.sunken` band answering the
operator's first three questions (today's money · open/paused · what's
waiting) with true `micro` eyebrow + `numL` money; replaces the hero card,
KPI tiles, and mid-board pitch. (3) Controls (open/pause, self-delivery,
manage links) moved BELOW the queue; the keep-100% pitch line to the bottom.
**Deviation from the audit's motion note (recorded honestly):** the audit
asked the new-order takeover be reduced to one ≤900ms entry moment. The
VIBRATION alarm beat stays — a missed order is money and the bell is
functional alerting, not decoration — but the VISUAL pulse now honours
`ReduceMotion.System` (screen still; buzz carries). **Stage 2 (13b,
registered):** virtualization, 44dp sweep across sub-screens, menu/history
error states, icon-set unification, danger-variant deletes.

## Visual pass (simulator, 2026-08-19) — first live critique round
Booted the real stack (API + Metro + iPhone 17 Pro sim) and LOOKED. The
elevated Home renders as designed: awning hem crisp, greeting time-aware,
tiles/commercial band correct. Fixed live: a dead/expired avatar URL left a
nameless pink circle — Image onError now falls back to the monogram (seen
broken → fixed → verified on-device). REGISTERED: **HOME-P1** scrolled
content collides with the clock (no status-bar scrim/compact-pin on scroll);
**RIG-1** baseline-harness "ELV1 Mains" category visible in dev data (cosmetic,
dev-only). Vendor board + remaining flows: next visual round.

## Flow 8 — Profile · stage 1 (2026-08-19, built AND verified on-device)
**From the scored register (9/20, tied-worst):** generic double-header, dead
camera badge, ten same-weight rows. Shipped: identity masthead (PROFILE
eyebrow · name · "With Swift since {year} · N orders") over the awning hem;
**THE TRUST HALO** (registered signature) — segmented ring around the avatar
where every lit segment is a REAL fact (phone verified · selfie on file ·
first order placed), unlit = the honest to-do, caption names the next step;
camera chip is now a real ≥44 action → Personal data; rows regrouped into
sunken-band Cards under true micro eyebrows (YOUR ACCOUNT · PRIVACY · HELP),
sentence-cased; Switch-app separated (it changes WHO you are); LoadingBlock/
ErrorState on the profile query; FadeInDown entrance with ReduceMotion.
Avatar dead-URL fallback added here too (found live: blank circle → M).
Verified in the simulator: halo 2-of-3 lit for the test account, exactly
honest. **Stage 2 (8b):** PersonalData flex-hole + pinned dock, cluster
headers → masthead variants, IdentityVerification off legacy components.
