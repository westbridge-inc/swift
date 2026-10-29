/**
 * Swift's published support contact: the ONE place the app reads it.
 *
 * Owner ruling, 11 Oct 2026: support is the company's public business line,
 * the same number the website lists (apps/web/src/site.config.ts `phone`) and
 * the one Apple may call. It answers WhatsApp messages and phone calls.
 * supportContact.test.ts keeps this in step with the website and fails if the
 * number or inbox is written anywhere else in the app source.
 *
 * It is a public business line by the owner's choice. Never add any other
 * phone number to the repository.
 */
const PHONE_E164 = '+5927163534';

export const SUPPORT_CONTACT = {
  email: 'support@swiftgy.com',
  /** How the number is written on screen. */
  phoneDisplay: '+592 716 3534',
  phoneE164: PHONE_E164,
  callUrl: `tel:${PHONE_E164}`,
  /** WhatsApp click-to-chat takes the international number without the plus. */
  whatsappUrl: `https://wa.me/${PHONE_E164.slice(1)}`,
} as const;
