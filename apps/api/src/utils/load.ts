/** Rough bag-size heuristic a mover can judge an offer by (spec §7):
 *  total units across all lines → small / medium / large. */
export function estimateLoad(totalUnits: number): 'small' | 'medium' | 'large' {
  if (totalUnits <= 3) return 'small';
  if (totalUnits <= 10) return 'medium';
  return 'large';
}
