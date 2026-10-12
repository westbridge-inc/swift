'use client';

import { getCart, type Cart } from './customer';
import { apiFetch } from './auth';
import type { ShellPerson } from '@/components/customer-shell';

/**
 * [WEB-REDESIGN] The two account reads the app's chrome shows: how many things
 * are in the cart (the rail's and the dock's badge) and who is signed in (the
 * rail's foot). Both are keyed to the person and the session epoch, the way
 * every other private read in the shell is, so a sign-out or a change of
 * person never shows the last person's answer.
 */

export function customerCartKey(scope: string, epoch: number) {
  return ['customer', 'cart', scope, epoch] as const;
}

export function shellPersonKey(scope: string, epoch: number) {
  return ['customer', 'me', scope, epoch] as const;
}

/** A background read: an expired session must never navigate away from it. */
export function readShellCart(): Promise<Cart> {
  return getCart({ redirectOnExpired: false });
}

/** Units in the cart: the sum of the lines' quantities, as the phone's badge
 *  counts. Anything that is not a well-formed cart counts as nothing. */
export function cartItemCount(cart: Cart | null | undefined): number {
  const lines = Array.isArray(cart?.items) ? cart.items : [];
  return lines.reduce((sum, line) => {
    const quantity = Number(line?.quantity);
    return Number.isInteger(quantity) && quantity > 0 ? sum + quantity : sum;
  }, 0);
}

export async function readShellPerson(): Promise<ShellPerson> {
  const response = await apiFetch('/api/v1/customer/profile', { cache: 'no-store', headers: { 'x-client-platform': 'web' } }, { redirectOnExpired: false });
  const profile = (response.data ?? {}) as { firstName?: string | null; lastName?: string | null; phone?: string | null };
  const name = `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim();
  return { name, phone: profile.phone ?? null };
}
