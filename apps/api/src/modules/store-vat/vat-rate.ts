/**
 * [STORE-VAT · owner O-5, 22 Oct 2026] THE one place Swift states the VAT rate a store's goods carry.
 *
 * Every number below comes from the GRA's own published law, never from memory:
 *   - Rate: 14%. Value-Added Tax Act Cap. 81:05, s.9(1); VAT Regulations 2005 reg. 2 ("The tax imposed
 *     under section 9(1) of the Act shall be at a rate of fourteen percent (14%)"), GRA consolidation
 *     revised 29 January 2025.
 *   - Tax fraction: R / (1 + R) (Act s.2 "tax fraction"; s.16(2)), which GRA VAT Policy #25 "VAT Fraction"
 *     states as 7/57 for 14% (= 14/114). The VAT inside a VAT-inclusive price is price x 7/57.
 *   - Rounding: the GRA states NO rounding rule (Policy #25 rounds its worked example, $1,000 -> $123,
 *     to a whole dollar). Swift's rule (COORD ruling 22 Oct, accountant to VERIFY after earnings, item V3):
 *     ONE amount per order, half-up to the whole Guyana dollar, from the exact fraction.
 *
 * This is NOT platform config: it needs no owner-signed seed (PLATFORM_CONFIG_VERSION is untouched), and
 * screens never carry the rate as a literal: the API sends it with every VAT figure it reports.
 * A change of rate is a code change here, reviewed like money, and applies only to orders placed after it
 * (every order freezes the rate it was priced under).
 */

/** The standard rate, in whole percent (VAT Regulations reg. 2). */
export const STORE_VAT_RATE_PERCENT = 14;

/** The tax fraction R/(100+R) as an exact integer ratio: 14/114 (= 7/57, GRA Policy #25). */
export const STORE_VAT_FRACTION = Object.freeze({ numerator: STORE_VAT_RATE_PERCENT, denominator: 100 + STORE_VAT_RATE_PERCENT });

/** The rate in basis points, as an order freezes it (1400 = 14%). */
export const STORE_VAT_RATE_BPS = STORE_VAT_RATE_PERCENT * 100;

/** Where a reader checks the numbers above. Shown to staff; never a claim to customers. */
export const STORE_VAT_SOURCES = Object.freeze([
  'Value-Added Tax Act Cap. 81:05, s.2, s.9(1), s.16(2), s.90; VAT Regulations 2005, reg. 2 and reg. 10(d) (GRA consolidation, revised 29 Jan 2025)',
  'GRA VAT Policy #25 "VAT Fraction"',
  'GRA VAT Policy #13 "VAT and Tax-Inclusive and Exclusive Pricing"',
]);
