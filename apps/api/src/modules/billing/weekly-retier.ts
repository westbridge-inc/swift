// ---------------------------------------------------------------------------
// [OWNER LEGAL PLAN 15 Oct 2026 · R27, research F2] The weekly re-tier is OFF.
//
// Every Monday (tier-recalc, 05:00 Guyana) the re-tier moved existing partners
// to the fee their rate card, catalogue or vehicle now gives them, at once and
// with no notice. The Mover and Business Agreements do not allow that: a price
// may change only as the contract allows, and the research's fair notice is 14
// days in the app, the new fee applying from the first weekly fee after that
// date. Until that notice ships (MONEY's F2 work), no partner moves to a new
// price: the scheduled job does nothing.
//
// A constant, not a setting: turning it back on is the F2 change itself
// (notice first, then the new fee from the first weekly fee after the notice
// period), reviewed as code, never an environment flip. A partner's fee is
// still set when they start (activation prices them from the current card);
// only the weekly move of existing partners stops.
// ---------------------------------------------------------------------------

export const WEEKLY_RETIER_ON = false;
