'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_GROUPS, navItemFor } from './nav';
import { label } from '@/lib/labels';

/** Initials for the signed-in role chip; the session carries roles, not a name. */
function roleInitials(role: string | null | undefined): string {
  return role === 'SUPER_ADMIN' ? 'SA' : role === 'ADMIN' ? 'AD' : '··';
}

/**
 * [MISSION CONTROL · shell] The sidebar in the owner's design: six groups,
 * the current screen marked (and announced with aria-current), and the
 * signed-in role at the foot in plain words.
 */
export function Sidebar({ onNavigate, role }: { onNavigate?: () => void; role?: string | null }) {
  const pathname = usePathname();
  const current = navItemFor(pathname);

  return (
    <aside className="mc-sidebar">
      <div className="mc-sidebar-brand">
        <span className="mc-numbers">Swift</span> Mission Control
      </div>
      <nav aria-label="Mission Control" className="mc-sidebar-nav">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="mc-sidebar-group">
            <p className="mc-sidebar-title" id={`nav-${group.title}`}>{group.title}</p>
            <ul aria-labelledby={`nav-${group.title}`}>
              {group.items.map((item) => {
                const active = current?.href === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={`mc-sidebar-link${active ? ' is-active' : ''}`}
                    >
                      <item.icon size={16} aria-hidden="true" />
                      <span className="mc-truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="mc-sidebar-foot">
        <span className="mc-avatar mc-numbers" aria-hidden="true">{roleInitials(role)}</span>
        <span className="min-w-0">
          <span className="block font-semibold">Signed in</span>
          <span className="block mc-muted text-xs">{role ? label('UserRole', role) : 'Checking your session…'}</span>
        </span>
      </div>
    </aside>
  );
}
