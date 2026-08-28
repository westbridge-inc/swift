/**
 * TOMBSTONE [WS-2.1] — `RideSheet` is now `Sheet`.
 *
 * It was built for the ride flow (rides spec 3.4) and named for it, which is
 * why nothing else ever adopted it: the taxi and cockpit screens each reached
 * for `@gorhom/bottom-sheet` directly rather than a component whose name said
 * it belonged to someone else. Generalized in `sheet.tsx` — same three detents,
 * same height callback, plus the 28pt top radius and the optional brand header
 * the design system asks for.
 *
 * Kept as an alias rather than deleted: it has ZERO call sites today, so this
 * costs nothing, and deletion is a founder call (the standing FG-2 rule that
 * kept `GradientMasthead`). Logged as a deletion candidate.
 *
 * New code imports `Sheet`.
 */
export { Sheet as RideSheet, type SheetDetent as RideDetent, type SheetProps as RideSheetProps } from './sheet';
