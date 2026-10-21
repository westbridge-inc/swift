/**
 * [ROLE-DOCS · owner ruling 21 Oct 2026] "I trade under my own name" — the words a store owner ticks at sign-up in
 * place of a business registration, ONLY where the Business Names (Registration) Act, Cap. 90:05, s.3 makes
 * registration unnecessary. The server's words (apps/api/src/modules/vendor/own-name.ts OWN_NAME_DECLARATION_V1)
 * are what is signed; a test keeps these equal.
 */
export const OWN_NAME_DECLARATION_WEB = `I TRADE UNDER MY OWN NAME (v1)

I declare that:
1. I run this store myself, as one person (not a partnership or a company).
2. The store's name is my true surname, with nothing added except my true first names or their initials.
3. I have not changed my name, other than by marriage.
4. Under the Business Names (Registration) Act, Cap. 90:05, section 3, I therefore do not need to register a business name.
5. If I trade under any other name, I will register it with the Deeds and Commercial Registries Authority (DCRA) and upload the certificate to Swift before I use it.`;

/** The store types asked for a business registration (a service business never is). */
export function ownNameStoreType(vendorType: string): boolean {
  return vendorType === 'RESTAURANT' || vendorType === 'SUPERMARKET' || vendorType === 'STORE';
}
