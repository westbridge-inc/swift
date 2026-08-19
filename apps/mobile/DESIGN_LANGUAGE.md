# DESIGN_LANGUAGE — Swift mobile (design-100× Part 2 journal)

The finished language, kept current. Source of truth for VALUES:
`packages/ui/src/tokens.ts` — this file explains the LANGUAGE so a new screen
can be designed on-language without reading anything else.

## Palette (roles, not hexes — hexes live in tokens.ts)
- `brand[500]` CTAs/active/links · `brand[600]` pressed/deep emphasis ·
  `brand[50/100]` tints, icon tiles, selected states.
- Surfaces: `base` cards · `subtle` the paper background · `sunken` grouped
  bands (the Home commercial band) · `onBrand` chrome chips on maroon.
- Masthead wash: `color.masthead` 500→600, top→bottom (GradientMasthead).
- Functional: success viridian / error hot red (never the brand — two-reds
  law) / warning burnt amber / info slate. Meaning never by colour alone.

## Type
Bricolage Grotesque = display (titles + ALL tabular money: displayXl,
display, title, numL, numM — face integrity enforced in kit/text.tsx);
Hanken Grotesk = body (heading, body, bodyStrong, label, caption, micro).
Money is ALWAYS tabular. Max two display-face moments per screen — Home
spends one on the time-aware greeting.

## Shape & rhythm
Spacing: tokens.space only (4→48). Radius: sm 8 / md 12 / lg 16 / full —
max two per screen plus full. Elevation: tokens.elevation; rows prefer
borders over shadows.

## Motion (tokens 9.4)
instant 80 press-in · fast 140 press-out · base 220 sheets · gentle 320
first-paint stagger (once, ≤8 items, reduced-motion honored) · moments ≤900.
The pressed mechanic lives in components/ui/pressable-scale.tsx.

## Haptics
select on choose · medium on commit (Place order / Accept / Go online) ·
success on placed/PIN/paid · warning on hold-expiry & item-unavailable ·
error on wrong PIN. Nothing else vibrates.

## Iconography & pictograms
One drawn hand: kit/pictograms.tsx (24-grid, 1.8 stroke, round caps) for
vertical tiles + brand moments; Feather for utility glyphs; filled variant
only for the active tab. Never emoji, never mixed families on one surface.

## Signature registry (one per screen — never repeat)
- **Home: the awning hem** (kit/masthead.tsx AwningEdge — the masthead
  resolves like a Georgetown shopfront awning; goods shelved under it).
- (next flows claim theirs here)

## Copy
Glossary verbs per the spec Part 11 (Place order · Track order · Go online
· Accept/Decline …). Errors = what happened + what to do. Empty states
invite. Sentence case everywhere. Money via the shared formatter only.
