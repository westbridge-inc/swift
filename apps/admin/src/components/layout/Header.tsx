'use client';

import { useRef } from 'react';
import { LogOut, Menu } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { logout } from '@/lib/api';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { SearchLauncher } from './CommandPalette';
import { navItemFor } from './nav';

/**
 * [MISSION CONTROL · shell] The header: where you are (the screen's name and
 * one line on what it is for), ⌘K search, and sign-out.
 *
 * Owner: "logging out of any account — the confirmation 'should we log you
 * out', like every other app." It still asks first — now in the page, not a
 * browser confirm (owner ruling, 6 Oct: no browser prompts) — and signs out on
 * the server exactly once, however many times the button is pressed.
 */
export function Header({ onOpenNavigation }: { onOpenNavigation?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const dialog = useActionDialog();
  const signingOut = useRef(false);
  const here = navItemFor(pathname ?? '');

  async function handleLogout() {
    if (signingOut.current) return;
    signingOut.current = true;
    try {
      const outcome = await dialog.run({
        title: 'Sign out of Swift Mission Control?',
        body: <p>You will need a code sent to your phone to sign in again on this browser.</p>,
        confirmLabel: 'Sign out',
        reason: false,
        // [A-01] revoke on the server (family + cookies); the shell fails closed to /login either way
        submit: () => logout(),
        success: () => 'Signed out.',
      });
      if (outcome?.tone === 'success') router.replace('/login');
    } finally {
      signingOut.current = false;
    }
  }

  return (
    <header className="mc-header">
      <button type="button" className="mc-btn mc-btn-quiet mc-nav-toggle" aria-label="Open navigation" onClick={onOpenNavigation}>
        <Menu size={18} aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="mc-header-title mc-truncate">{here?.label ?? 'Swift Mission Control'}</p>
        {here ? <p className="mc-header-blurb mc-truncate">{here.blurb}</p> : null}
      </div>
      <SearchLauncher />
      <button type="button" onClick={handleLogout} aria-label="Sign out" title="Sign out" className="mc-btn mc-btn-quiet">
        <LogOut size={18} aria-hidden="true" />
      </button>
    </header>
  );
}
