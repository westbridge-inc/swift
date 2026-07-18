'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Receipt, MapPin, LogOut, ChevronRight } from 'lucide-react';
import { apiFetch, clearSession } from '@/lib/auth';

export default function AccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(null);
  useEffect(() => { apiFetch('/api/v1/customer/profile').then((r) => setMe(r.data)).catch(() => {}); }, []);

  const links = [
    { href: '/orders', label: 'Your orders', Icon: Receipt },
    { href: '/order/location', label: 'Delivery addresses', Icon: MapPin },
  ];

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <div className="rounded-2xl border border-black/5 bg-white p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--swift-red)] text-lg font-black text-white">{(me?.firstName ?? 'U').charAt(0)}</span>
          <div>
            <p className="font-extrabold">{me ? `${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() || 'Your account' : 'Your account'}</p>
            <p className="text-sm text-[var(--swift-muted)]">{me?.phone ?? ''}</p>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-black/5 bg-white">
        {links.map(({ href, label, Icon }) => (
          <Link key={href} href={href} className="flex items-center gap-3 border-b border-black/5 px-5 py-4 last:border-0 hover:bg-[var(--swift-subtle)]">
            <Icon className="h-5 w-5 text-[var(--swift-red)]" />
            <span className="flex-1 font-semibold">{label}</span>
            <ChevronRight className="h-4 w-4 text-[var(--swift-muted)]" />
          </Link>
        ))}
      </div>

      <button onClick={() => { clearSession(); router.replace('/'); }} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--swift-red)] py-3 font-bold text-[var(--swift-red)]">
        <LogOut className="h-4 w-4" /> Sign out
      </button>
    </div>
  );
}
