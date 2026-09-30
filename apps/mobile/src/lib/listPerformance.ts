// Horizontal rails render just beyond the viewport; Market counts two-card
// rows. Keep variable-height text measurable (no invented getItemLayout).
export const HOME_RAIL_WINDOW = { initialNumToRender: 3, maxToRenderPerBatch: 3, windowSize: 3 } as const;
export const MARKET_WINDOW = { initialNumToRender: 4, maxToRenderPerBatch: 4, windowSize: 5 } as const;
