// [VAT-DOCS · owner 30 Oct 2026] How a store says its prices relate to VAT, in the reviewer's words: what approving does.
export function vatModeWords(mode: string | null): string {
  if (mode === 'ADD_VAT_AT_CHECKOUT') return 'Prices do not include VAT: approving adds VAT to each standard-rated price customers see';
  if (mode === 'PRICES_INCLUDE_VAT') return 'Prices already include VAT: approving leaves its prices as they are';
  return 'The store has not said how its prices relate to VAT: it cannot be approved yet';
}
