import { zustandStorage } from './storage';
import { CHECKOUT_ATTEMPT_STORAGE_KEY, createCheckoutAttempt, LEGACY_CHECKOUT_ATTEMPT_STORAGE_KEY, type CheckoutKeyStore } from './checkoutAttempt';

/** [TA-S1-001 / MOB-020] The app's checkout intent, persisted in the encrypted
 *  MMKV behind every persisted store. `initSecureStorage()` runs before the
 *  first screen renders, so by the time anyone can tap "Place order" it is
 *  open; if it is not, the factory's try/catch degrades to memory. The #990
 *  bare-key slot is read once and adopted as an unresolved intent. */
const slot = (key: string): CheckoutKeyStore => ({
  get: () => {
    const v = zustandStorage.getItem(key);
    return typeof v === 'string' ? v : null;
  },
  set: (value) => {
    void zustandStorage.setItem(key, value);
  },
  clear: () => {
    void zustandStorage.removeItem(key);
  },
});

export const checkoutAttempt = createCheckoutAttempt(slot(CHECKOUT_ATTEMPT_STORAGE_KEY), undefined, undefined, slot(LEGACY_CHECKOUT_ATTEMPT_STORAGE_KEY));
