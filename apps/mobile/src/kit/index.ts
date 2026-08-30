// The rebuilt customer design kit — Super Food layouts, Indian Red brand.
// Rules: tokens only (via @swift/ui), no imports from components/ui (legacy
// kit kept solely for the partner/mover/vertical screens).
export * from './text';
export * from './money';
export * from './add-morph';
export * from './menu-row';
export * from './code-input';
export * from './lock-in';
export * from './tab-glyphs';
export * from './screen';
export * from './button';
export * from './card';
export * from './controls';
export * from './masthead';
// (DocketEdge/ReceiptEdge/AwningEdge are GONE — the toothed-edge family was
// vetoed outright [2026-08-22], and a vetoed component that still exports is
// a vetoed component that will be used. DRIFT-08 closed.)
export * from './input';
export * from './rows';
export * from './states';
export * from './food';
export * from './placeholder';
export * from './photo-placeholder';
export * from './pictograms';
export * from './glyphs';
export * from './ride-sheet';
export * from './timeline';
export * from './photo-drop';
export * from './sheet';
export * from './vehicle-render';
export * from './map-style';
// [DRIFT-09] The nine legacy-only primitives, authored into the kit so
// components/ui can finally be removed — plus the two supports they ride on
// (PressableScale, Scrim). `Image` stays a direct import ('./image'): as a
// barrel export it shadows react-native's and invites the wrong autocomplete.
export * from './toast';
export * from './toast-duration';
export * from './action-sheet';
export * from './confirm-dialog';
export * from './step-progress';
// (No './promo-banner': DRIFT-09 listed PromoBanner as legacy-only, but the
// kit had since grown its OWN in food.tsx — the founder-corrected F-263
// treatment. The older swift-watermark banner dies with the legacy folder.)
export * from './avatar';
export * from './badge';
export * from './canopy';
export * from './choice-chip';
export * from './pressable-scale';
export * from './scrim';
export * from './switch';
// [Wave 3] The composite primitives the Design Standard names on nearly every
// screen — authored once here so the 50-screen rebuilds compose instead of
// hand-rolling: Eyebrow/StatePill/StatusDot, IconTile/StatTile, Dock,
// Segmented, ReceiptBill, MapPeek.
export * from './labels';
export * from './tiles';
export * from './dock';
export * from './segmented';
export * from './receipt-bill';
export * from './map-peek';
// [Wave 3 part 2] Promotions — pieces born inside one screen whose moment is
// platform-wide: the fare slider (MoverHome offer card), the hold ring + its
// pure honesty seams (DeliveryScreen), and the calm searching radar
// (TaxiScreen's rings, generalized).
export * from './fare-slider';
export * from './fare-step';
export * from './hold-ring';
export * from './hold-window';
export * from './calm-radar';
export * from './trust-halo';
// [#910's law] modal exits close in their own tick; navigation goes here.
export * from './after-dismiss';
