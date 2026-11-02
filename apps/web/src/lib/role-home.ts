/**
 * [FLOW-QA F1 · F5b] Where an account belongs, from its roles alone: the one rule sign-in, sign-up, the signed-in
 * card and the public header share (lib/auth verifyPartnerLogin uses the same test). A self-employed pro holds no
 * partner role; the pages that can ask the server (hasProviderProfile) route them on from here.
 */
export type RoleHome = { home: '/dashboard' | '/portal' | '/'; kind: 'business' | 'earner' | 'customer' };

export function roleHome(user: { roles?: unknown; vendorOwner?: unknown } | null | undefined): RoleHome {
  const roles = Array.isArray(user?.roles) ? (user.roles as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  if (roles.includes('VENDOR') || roles.includes('VENDOR_OWNER') || !!user?.vendorOwner) return { home: '/dashboard', kind: 'business' };
  if (roles.some((r) => r === 'MOVER' || r === 'RIDER' || r === 'DRIVER')) return { home: '/portal', kind: 'earner' };
  return { home: '/', kind: 'customer' };
}
