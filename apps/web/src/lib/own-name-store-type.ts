// [ROLE-DOCS · #2046] Kept apart from own-name-copy.ts so the sign-up page can decide at once whether a store is
// offered the own-name choice without loading the declaration's words (they load with the choice: own-name-choice.tsx).
/** The store types asked for a business registration (a service business never is). */
export function ownNameStoreType(vendorType: string): boolean {
  return vendorType === 'RESTAURANT' || vendorType === 'SUPERMARKET' || vendorType === 'STORE';
}
