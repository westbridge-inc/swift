/**
 * [ROLE-DOCS · owner ruling 21 Oct 2026] "I trade under my own name": the words a store owner ticks in place of a
 * business registration, ONLY where the Business Names (Registration) Act, Cap. 90:05, s.3 makes registration
 * unnecessary (one person whose store's name is their true surname with nothing added but their first names or
 * initials). The server's words (apps/api/src/modules/vendor/own-name.ts OWN_NAME_DECLARATION_V1) are the signed
 * version; a test keeps these equal.
 */
export const OWN_NAME_DECLARATION_VERSION = 'v1';

export const OWN_NAME_DECLARATION_V1 = `I TRADE UNDER MY OWN NAME (v1)

I declare that:
1. I run this store myself, as one person (not a partnership or a company).
2. The store's name is my true surname, with nothing added except my true first names or their initials.
3. I have not changed my name, other than by marriage.
4. Under the Business Names (Registration) Act, Cap. 90:05, section 3, I therefore do not need to register a business name.
5. If I trade under any other name, I will register it with the Deeds and Commercial Registries Authority (DCRA) and upload the certificate to Swift before I use it.`;

/** The sign-up's question, in the owner's words. */
export const OWN_NAME_QUESTION = 'What name does your store use?';
export const OWN_NAME_CHOICE = 'My own name — just my surname, with or without my first names or initials (for example “Persaud” or “R. Persaud”)';
export const BUSINESS_NAME_CHOICE = 'A business name, or a company';
export const OWN_NAME_HINT = 'The law does not ask you to register your own name as a business name, so you sign a short declaration instead of uploading a business registration. A person on our team checks it against your ID.';
export const OWN_NAME_TICK = 'I have read the declaration above and I sign it.';

/** The vendor types whose checklist asks for a business registration (a service business is never asked). */
export function ownNameApplies(vendorType: string): boolean {
  return vendorType === 'RESTAURANT' || vendorType === 'SUPERMARKET' || vendorType === 'STORE';
}
