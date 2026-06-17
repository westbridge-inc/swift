/** Format a GYD amount for display. Guyanese dollars are whole-number; uses the
 *  local "$" convention (matches the rest of the consumer UI). */
export const money = (n: number | null | undefined) => `$${Math.round(Number(n ?? 0)).toLocaleString()}`;
