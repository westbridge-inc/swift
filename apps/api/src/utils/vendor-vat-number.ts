import { AppError } from './errors';

/**
 * [VERIFY-DOCS · owner ruling 7, 6 Oct 2026] A store's VAT registration number, typed by its owner only
 * if the business is VAT-registered, for VAT tax invoices (VAT Act s.28(1), Schedule III para 1(c)).
 *
 * Format only — never looked up anywhere: spaces and hyphens are dropped and what is left must be 6 to
 * 15 digits. Whether GRA uses the TIN itself as the VAT number (VAT Act s.87) is an open accountant
 * question, so the check refuses words and fragments without presuming the exact length.
 * `null` or an empty string takes the number off.
 */
export const VAT_NUMBER_INVALID = 'VAT_NUMBER_INVALID';

export function vatNumberForWrite(raw: string | null): string | null {
  if (raw === null) return null;
  const compact = raw.replace(/[\s-]+/g, '');
  if (compact === '') return null;
  if (!/^\d{6,15}$/.test(compact)) {
    throw new AppError(400, VAT_NUMBER_INVALID, 'That does not look like a VAT registration number. Type the digits exactly as GRA issued them, or leave it empty if the business is not VAT-registered.');
  }
  return compact;
}
