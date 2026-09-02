import { zustandStorage } from './storage';
import { CHECKOUT_ATTEMPT_STORAGE_KEY, createCheckoutAttempt, type CheckoutKeyStore } from './checkoutAttempt';

/** [TA-S1-001] The app's checkout attempt, persisted in the encrypted MMKV
 *  behind every persisted store. `initSecureStorage()` runs before the first
 *  screen renders, so by the time anyone can tap "Place order" it is open; if
 *  it is not, the factory's try/catch degrades to memory. */
const secureKeyStore: CheckoutKeyStore = {
  get: () => {
    const v = zustandStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
    return typeof v === 'string' ? v : null;
  },
  set: (key) => {
    void zustandStorage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, key);
  },
  clear: () => {
    void zustandStorage.removeItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
  },
};

export const checkoutAttempt = createCheckoutAttempt(secureKeyStore);
