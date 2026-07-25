import { z } from 'zod';

/**
 * Normalize a user-entered phone to the ONE canonical form the platform stores
 * and matches on (E.164, digits only after the +). Strips spaces, dashes,
 * parentheses and dots, so every client's formatting is reconciled here rather
 * than at each keyboard:
 *
 *   "+592 600 1000"  ->  "+5926001000"
 *   "+592-600-1000"  ->  "+5926001000"
 *   "(592) 600 1000" ->  "+5926001000"  (only when a + is present)
 *
 * A leading + is preserved. We do NOT invent a country code for a plain local
 * number (that would be a guess); the apps prepend the dialing code before they
 * ever reach here. This is purely a formatting reconciliation so a customer,
 * driver, rider or vendor who types a space never gets "no account found".
 */
export function normalizePhone(raw: string): string {
  const s = raw.trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  return (plus ? '+' : '') + digits;
}

/**
 * Shared phone field for every auth surface (send-otp, verify-otp, register,
 * password login, reset). Normalizes FIRST, then validates the canonical shape,
 * so a handler downstream always sees clean E.164.
 */
export const zPhone = z
  .string()
  .transform(normalizePhone)
  .pipe(z.string().min(8).max(16).regex(/^\+?[0-9]+$/, 'Enter a valid phone number'));
