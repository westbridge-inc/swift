// [REVIEW-LIGHT2 #2306 S3] The app's words for a store held from orders (apps/mobile VendorBillingSuspended for a weekly
// fee hold, VendorStoreBlocked STORE_HOLD_COPY for the others), kept here because those screens import React Native.
// store-hold-card.test.tsx holds each one to the app's file. Which hold applies is the app's own reading
// (lib/vendorProfile storeHoldOf: the store's status and the server's suspension source).
export const STORE_HOLD_WORDS = {
  FEE_UNPAID: {
    title: 'New orders are paused',
    owner: 'The weekly fee needs attention. Open Weekly fee to view your checkout; a credited payment clears the billing hold.',
    staff: 'The store’s weekly fee needs attention. Ask the owner to open Weekly fee; only the owner can access billing.',
  },
  SUSPENDED_BY_SWIFT: { title: 'Swift has suspended this store', body: 'Orders are off while the store is suspended. Ask Swift support why, and what will restore it — a person answers. Paying the weekly fee does not lift this kind of hold.' },
  SUSPENDED: { title: 'This store is suspended', body: 'Orders are off while the store is suspended. Ask Swift support why, and what will restore it — a person answers.' },
  OWNER_ACCOUNT_CLOSED: { title: 'This store was closed', body: 'It closed when the owner’s Swift account was closed, so it can’t take or work orders. If that’s a mistake, ask Swift support.' },
  CLOSED: { title: 'This store is closed', body: 'A closed store can’t take or work orders. If it should be open, ask Swift support.' },
} as const;
