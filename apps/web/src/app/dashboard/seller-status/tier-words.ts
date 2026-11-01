// [WEB-SETTINGS PR-B · REVIEW-F #2281 S2-1] A page.tsx exports only its page, so the page's words live here.

/** The phone's words (VendorTierScreen; the test reads them there). */
export const TIER_WORDS = {
  staff: 'Seller status is shown to the store’s manager and owner.',
  near: 'You are near a limit. Orders past it are refused until the day or week rolls over.',
  promotedLater: 'Promoted placement opens once your business is registered.',
  noLimits: 'No order or sales limits apply. Promoted placement is open to you.',
  steps: [
    '1. Register your business name with the Deeds and Commercial Registries Authority (DCRA).',
    '2. Get the Business Registration Certificate.',
    '3. Upload it under your documents. The limits lift the day it is verified, and we tell you.',
  ],
} as const;
