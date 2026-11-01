// [WEB-SETTINGS PR-B · REVIEW-F #2281 S2-1] A page.tsx exports only its page, so the page's words live here.

/** The phone's words (VendorCategoryReviewScreen; the test reads them there). */
export const CATEGORY_WORDS = {
  staff: 'Categories are reviewed by the store’s manager and owner.',
  browse: 'Customers browse the Market by category.',
  emptyTitle: 'Nothing to review',
  emptyBody: 'Every listing that could be categorised has been. New suggestions appear here when you add items.',
  final: 'Either answer is final — we won’t ask about the same listing again.',
  failed: 'Couldn’t save that — try again.',
} as const;
