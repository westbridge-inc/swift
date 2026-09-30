'use client';

import { useRef } from 'react';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { logout } from '@/lib/api';
import { GlobalSearch } from './GlobalSearch';

export function Header() {
  const router = useRouter();
  const signingOut = useRef(false);

  async function handleLogout() {
    // Ask first, like every sign-out in Swift, in this console's own confirm
    // (each irreversible admin action asks through window.confirm). Once
    // confirmed, a second click cannot start a second sign-out.
    if (signingOut.current) return;
    if (!window.confirm('Sign out of Swift Admin on this browser?')) return;
    signingOut.current = true;
    // [A-01] revoke on the server (family + cookies); the shell fails closed to /login either way
    await logout();
    router.replace('/login');
  }

  return (
    <header className="h-16 bg-[var(--panel)] border-b border-[var(--border)] flex items-center justify-between px-6">
      <GlobalSearch />
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[var(--accent)] flex items-center justify-center text-sm font-bold">
            SA
          </div>
          <span className="text-sm">Swift Admin</span>
        </div>
        <button
          onClick={handleLogout}
          title="Sign out"
          className="p-2 text-[var(--muted)] hover:text-white transition-colors"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
