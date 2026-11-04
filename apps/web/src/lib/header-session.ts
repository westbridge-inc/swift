import { sessionProbe } from '@/lib/auth';
import { isProvider } from '@/lib/partner-profiles';
import { roleHome } from '@/lib/role-home';

/**
 * [FLOW-QA F5b] The public header's account link for a signed-in partner: "Dashboard" for a business, "My portal"
 * for a rider or driver, "My weekly fee" for a self-employed pro. Loaded on demand by the header (site-nav), and asked
 * only in a browser that has signed in before (lib/session-hint), so a guest's page costs nothing.
 */
export async function headerAccount(): Promise<{ href: string; label: string } | null> {
  const session = await sessionProbe();
  if (!session.ok || !session.user) return null;
  const { kind } = roleHome(session.user);
  if (kind === 'business' || kind === 'staff') return { href: '/dashboard', label: 'Dashboard' };
  if (kind === 'earner') return { href: '/portal', label: 'My portal' };
  return (await isProvider()) ? { href: '/portal/weekly-fee', label: 'My weekly fee' } : null;
}
