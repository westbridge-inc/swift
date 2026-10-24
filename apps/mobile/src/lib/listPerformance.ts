// Horizontal rails render just beyond the viewport; Market counts two-card
// rows. Keep variable-height text measurable (no invented getItemLayout).
export const HOME_RAIL_WINDOW = { initialNumToRender: 3, maxToRenderPerBatch: 3, windowSize: 3 } as const;
export const MARKET_WINDOW = { initialNumToRender: 4, maxToRenderPerBatch: 4, windowSize: 5 } as const;
// [SPEED 22 Oct] The store's Products/Menu tab: about one screen of item rows on
// the first frame, the rest drawn in small batches as the owner scrolls.
export const MENU_LIST_WINDOW = { initialNumToRender: 8, maxToRenderPerBatch: 8, windowSize: 7 } as const;
