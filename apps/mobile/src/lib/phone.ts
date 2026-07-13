// Per-market phone rules for Swift's 13 Caribbean countries.
//
// The dial code already carries the country/area code (e.g. +1268 for Antigua,
// +592 for Guyana), so `nsnLength` is the LOCAL subscriber number the user
// actually types. Every current market is 7 digits — the NANP islands are
// area-code + 7 (area code lives in the dial code), and Guyana / Belize /
// Suriname mobile are 7 too. `example` is a realistic local number so the
// placeholder matches the chosen country instead of always showing a Guyana one.
//
// Curated table, not a phone library: the market list is fixed (it mirrors the
// backend CountryConfig), so this stays dependency-free and auditable. Add a row
// when a market is added.
export type PhoneRule = { example: string; nsnLength: number };

const PHONE_RULES: Record<string, PhoneRule> = {
  AG: { example: '464 1234', nsnLength: 7 }, // Antigua & Barbuda (+1268)
  BS: { example: '359 1234', nsnLength: 7 }, // Bahamas (+1242)
  BB: { example: '250 1234', nsnLength: 7 }, // Barbados (+1246)
  BZ: { example: '610 1234', nsnLength: 7 }, // Belize (+501)
  DM: { example: '225 1234', nsnLength: 7 }, // Dominica (+1767)
  GD: { example: '403 1234', nsnLength: 7 }, // Grenada (+1473)
  GY: { example: '612 3456', nsnLength: 7 }, // Guyana (+592)
  JM: { example: '210 1234', nsnLength: 7 }, // Jamaica (+1876)
  KN: { example: '765 1234', nsnLength: 7 }, // Saint Kitts & Nevis (+1869)
  LC: { example: '284 1234', nsnLength: 7 }, // Saint Lucia (+1758)
  VC: { example: '430 1234', nsnLength: 7 }, // Saint Vincent & the Grenadines (+1784)
  SR: { example: '741 1234', nsnLength: 7 }, // Suriname (+597, mobile)
  TT: { example: '291 1234', nsnLength: 7 }, // Trinidad & Tobago (+1868)
};

const FALLBACK: PhoneRule = { example: '612 3456', nsnLength: 7 };

/** Phone rule for a market code (ISO alpha-2). Falls back to a 7-digit default. */
export function phoneRule(countryCode?: string | null): PhoneRule {
  return (countryCode ? PHONE_RULES[countryCode] : undefined) ?? FALLBACK;
}
