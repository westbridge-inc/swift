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
} from 'lucide-react';

const navItems = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Orders', href: '/orders', icon: ShoppingCart },
  { label: 'Vendors', href: '/vendors', icon: Store },
  { label: 'Riders', href: '/riders', icon: Bike },
  { label: 'Drivers', href: '/drivers', icon: Car },
  { label: 'Verification', href: '/verification', icon: ShieldCheck },
  { label: 'Users', href: '/users', icon: Users },
  { label: 'Finance', href: '/finance', icon: DollarSign },
  { label: 'Promos', href: '/promos', icon: Tag },
  { label: 'Zones', href: '/zones', icon: Map },
  { label: 'Config', href: '/config', icon: Settings },
  { label: 'Audit Log', href: '/audit', icon: FileText },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-[#1C1C1E] border-r border-[#38383A] flex flex-col">
      <div className="p-6 border-b border-[#38383A]">
        <h1 className="text-xl font-bold">
          <span className="text-[#FF6B00]">Swift</span> Admin
        </h1>
      </div>
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-[#FF6B00]/10 text-[#FF6B00]'
                  : 'text-[#8E8E93] hover:text-white hover:bg-white/5'
              }`}
            >
              <item.icon size={18} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
