/**
 * Dial-prefix → ISO country for Swift's Caribbean footprint. The phone number
 * — not a client-supplied field — decides which country's pricing, currency,
 * and document checklists apply, so a signup can't point itself at another
 * market's cheaper tiers. NANP islands share +1 and split by area code.
 */
const NANP_AREA_TO_COUNTRY: Record<string, string> = {
  '868': 'TT', // Trinidad & Tobago
  '246': 'BB', // Barbados
  '876': 'JM', // Jamaica
  '658': 'JM', // Jamaica (overlay)
  '758': 'LC', // Saint Lucia
  '784': 'VC', // Saint Vincent & the Grenadines
  '473': 'GD', // Grenada
  '767': 'DM', // Dominica
  '869': 'KN', // Saint Kitts & Nevis
  '268': 'AG', // Antigua & Barbuda
  '242': 'BS', // Bahamas
};

export function countryFromPhone(phone: string): string | null {
  const p = phone.replace(/[^\d+]/g, '');
  if (p.startsWith('+592')) return 'GY'; // Guyana
  if (p.startsWith('+597')) return 'SR'; // Suriname
  if (p.startsWith('+501')) return 'BZ'; // Belize
  if (p.startsWith('+1')) return NANP_AREA_TO_COUNTRY[p.slice(2, 5)] ?? null;
  return null;
}
