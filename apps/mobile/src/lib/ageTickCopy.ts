/**
 * [Owner ruling 15 Oct 2026] The sign-up's 18+ tick (phone build 12). The label is the exact text the API
 * records in the consent ledger (apps/api auth/age-declaration.ts AGE_DECLARATION_V1); ageTickCopy.test.ts
 * holds the two together. Builds 9-11 have no tick and send no field; the server still admits them.
 */
export const AGE_TICK_LABEL = 'I am 18 or older.';
