'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ShoppingCart,
  Store,
  Bike,
  Car,
  Users,
  DollarSign,
  Tag,
  Map,
  Settings,
  FileText,
  ShieldCheck,
  ShieldAlert,
  Flag,
  Megaphone as AdsIcon,
  RefreshCw,
  LifeBuoy,
  PackageOpen,
  Megaphone,
  Radar,
  Globe,
  Bot,
  Scale,
  ListRestart, Compass,
} from 'lucide-react';

// Grouped by what the operator is doing, not by table name. Sections only list
// pages that exist — a dead link is worse than a missing one.
const NAV_SECTIONS: { title: string; items: { label: string; href: string; icon: typeof LayoutDashboard }[] }[] = [
  {
    title: 'Operations',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Live map', href: '/ops', icon: Radar },
      { label: 'Orders', href: '/orders', icon: ShoppingCart },
      { label: 'Ops agent', href: '/agent', icon: Bot },
    ],
  },
  {
    title: 'People',
    items: [
      { label: 'Users', href: '/users', icon: Users },
      { label: 'Vendors', href: '/vendors', icon: Store },
      { label: 'Riders', href: '/riders', icon: Bike },
      { label: 'Drivers', href: '/drivers', icon: Car },
      { label: 'Verification', href: '/verification', icon: ShieldCheck },
      { label: 'Compliance', href: '/compliance', icon: Scale },
    ],
  },
  {
    title: 'Money',
    items: [
      { label: 'Finance', href: '/finance', icon: DollarSign },
      { label: 'Subscriptions', href: '/subscriptions', icon: RefreshCw },
      { label: 'Claims', href: '/claims', icon: ShieldAlert },
      { label: 'Promos', href: '/promos', icon: Tag },
    ],
  },
  {
    title: 'Support',
    items: [
      { label: 'Tickets', href: '/support', icon: LifeBuoy },
      { label: 'Moderation', href: '/moderation', icon: Flag },
      { label: 'Discovery', href: '/discovery', icon: Compass },
      { label: 'Ads review', href: '/ads', icon: AdsIcon },
      { label: 'Returns', href: '/returns', icon: PackageOpen },
      { label: 'Broadcast', href: '/broadcast', icon: Megaphone },
    ],
  },
  {
    title: 'Platform',
    items: [
      { label: 'Markets', href: '/markets', icon: Globe },
      { label: 'Zones', href: '/zones', icon: Map },
      { label: 'Background jobs', href: '/jobs', icon: ListRestart },
      { label: 'Config', href: '/config', icon: Settings },
      { label: 'Audit Log', href: '/audit', icon: FileText },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-[var(--panel)] border-r border-[var(--border)] flex flex-col">
      <div className="p-6 border-b border-[var(--border)]">
        <h1 className="text-xl font-bold">
          <span className="text-[var(--accent)]">Swift</span> Admin
        </h1>
      </div>
      <nav className="flex-1 p-4 space-y-4 overflow-y-auto">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title}>
            <p className="px-3 pb-1 text-[10px] font-semibold tracking-widest text-[var(--muted)]/70">
              {section.title.toUpperCase()}
            </p>
            <div className="space-y-1">
              {section.items.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'text-[var(--muted)] hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <item.icon size={18} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}
