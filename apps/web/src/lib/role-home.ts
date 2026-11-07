/**
 * [FLOW-QA F1 · F5b] Where an account belongs, from its roles alone: the one rule sign-in, sign-up, the signed-in
 * card and the public header share (lib/auth verifyPartnerLogin uses the same test). A self-employed pro holds no
 * partner role; the pages that can ask the server (hasProviderProfile) route them on from here.
 */
export type RoleHome = { home: '/dashboard' | '/portal' | '/'; kind: 'business' | 'earner' | 'staff' | 'customer' };

export function roleHome(user: { roles?: unknown; vendorOwner?: unknown; storeStaff?: unknown } | null | undefined): RoleHome {
  const roles = Array.isArray(user?.roles) ? (user.roles as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  if (roles.includes('VENDOR') || roles.includes('VENDOR_OWNER') || !!user?.vendorOwner) return { home: '/dashboard', kind: 'business' };
  if (roles.some((r) => r === 'MOVER' || r === 'RIDER' || r === 'DRIVER')) return { home: '/portal', kind: 'earner' };
  // [BUG-HUNT F03] Branch staff hold no partner role: the server says they work at a store. They own no business, so
  // the business door still offers to add one; their home is the store's dashboard.
  if (user?.storeStaff === true) return { home: '/dashboard', kind: 'staff' };
  return { home: '/', kind: 'customer' };
}
