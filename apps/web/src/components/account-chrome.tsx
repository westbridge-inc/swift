'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { Modal } from '@/components/modal';
import { Pictogram, type PictogramName } from '@/components/glyphs';
import { getCapabilities } from '@/lib/capabilities';

/**
 * The account chrome the customer shell and the partner consoles share: the person's initial, the bottom sheet, and
 * "Switch app". Moved out of components/customer-shell (CI perf #2220) so a console's first load no longer carries
 * the customer app's tabs, rail and route table: console-shell imports only this.
 */

function initial(name: string | null | undefined): string {
  return (name ?? '').trim().charAt(0).toUpperCase() || 'S';
}

export function Avatar({ name, size = 40 }: { name: string | null | undefined; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid flex-none place-items-center rounded-full bg-[var(--swift-red-50)] font-bold text-[var(--swift-red)]"
      style={{ width: size, height: size, fontSize: size >= 56 ? 22 : 15 }}
    >
      {initial(name)}
    </span>
  );
}

export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal label={label} onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-3">
      <span aria-hidden className="mx-auto mb-4 block h-1 w-10 rounded-full bg-[var(--swift-border-strong)] wide:hidden" />
      {children}
    </Modal>
  );
}

/** Which Swift app the reader is in when they open "Switch app". */
export type SwitchAppKey = 'customer' | 'driver' | 'vendor' | 'advertiser';

const SWITCH_ROLES: { key: SwitchAppKey; label: string; sub: string; pictogram: PictogramName; href: string | null }[] = [
  { key: 'customer', label: 'Swift', sub: 'Order food, groceries and parcels', pictogram: 'food', href: '/' },
  { key: 'driver', label: 'Swift Driver', sub: 'Your earnings and documents — jobs are taken in the Swift app', pictogram: 'wheel', href: '/portal' },
  { key: 'vendor', label: 'Swift Business', sub: 'Your store’s orders and menu', pictogram: 'shops', href: '/dashboard' },
  { key: 'advertiser', label: 'Swift Ads', sub: 'Advertising is managed in the Swift app', pictogram: 'scan', href: null },
];

/**
 * "Switch app": one account, the other Swift apps it can open on the web.
 * Every pick is plain navigation — the server's active role is the phone
 * app's, and changing it here could take a rider off duty. Swift Ads becomes a
 * door only while the server's advertising switch is on (off at launch).
 */
export function SwitchAppSheet({ onClose, current = 'customer' }: { onClose: () => void; current?: SwitchAppKey }) {
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: getCapabilities, staleTime: 60_000 });
  const adsOpen = capabilities.data?.adsEnabled === true;
  return (
    <Sheet label="Switch app" onClose={onClose}>
      <>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <h2 className="sw-title">Switch app</h2>
              <p className="sw-caption mt-0.5">One account — choose how you’re using Swift right now.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" data-modal-initial-focus className="sw-icon-btn"><X size={20} aria-hidden /></button>
          </div>
          <ul className="mt-4">
            {SWITCH_ROLES.map((role) => {
              const here = role.key === current;
              const ads = role.key === 'advertiser' && adsOpen;
              const href = ads ? '/advertiser' : role.href;
              const sub = ads ? 'Your campaigns and advertising account' : role.sub;
              const body = (
                <>
                  <span className={`grid h-12 w-12 flex-none place-items-center rounded-2xl ${here ? 'bg-[var(--swift-red)] text-[var(--swift-white)]' : 'bg-[var(--swift-sunken)] text-[var(--swift-ink)]'}`}>
                    <Pictogram name={role.pictogram} size={24} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="sw-label">{role.label}</span>
                    <span className="sw-caption">{sub}</span>
                  </span>
                  {here ? <Check size={18} className="text-[var(--swift-red)]" aria-label="You are here" /> : null}
                </>
              );
              return (
                <li key={role.key}>
                  {here ? (
                    <button type="button" onClick={onClose} aria-current="true" className="sw-row cursor-pointer py-3">{body}</button>
                  ) : href ? (
                    <Link href={href} onClick={onClose} className="sw-row py-3">{body}</Link>
                  ) : (
                    <div className="sw-row py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
      </>
    </Sheet>
  );
}
