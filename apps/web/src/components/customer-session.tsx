'use client';

import { createContext, useContext } from 'react';

/**
 * [Q7b] What the customer shell knows about who is browsing, shared with the
 * pages inside it so none of them has to ask the server again.
 *
 * - `checking`: the one probe of this page load is still in flight.
 * - `signed-in`: the server named a user.
 * - `guest`: it did not. A guest can still browse everything public.
 *
 * `scope` keys every per-person cache (the principal, or "guest"), so a cached
 * answer for one person never renders under another.
 */
export type SessionStatus = 'checking' | 'signed-in' | 'guest';

export interface NearPoint { lat: number; lng: number }

export interface CustomerSession {
  status: SessionStatus;
  scope: string;
  /** Changes whenever the person changes after the first answer; anything a
   *  page keeps between answers is kept only within one epoch. */
  epoch: number;
  /**
   * True once the server confirms a session. An access cookie that expired
   * while the refresh cookie lives is restored first — at most once per page
   * load. Call it right before anything that needs an account.
   */
  ensureSignedIn: () => Promise<boolean>;
  /** Where a guest asked to see stores from. Held by the shell for this page
   *  load only — Home keeps its order when you come back to it, and nothing
   *  about where you are is ever stored. */
  nearPoint: NearPoint | null;
  setNearPoint: (_point: NearPoint | null) => void;
}

const CustomerSessionContext = createContext<CustomerSession>({
  status: 'checking',
  scope: 'guest',
  epoch: 0,
  ensureSignedIn: async () => false,
  nearPoint: null,
  setNearPoint: () => undefined,
});

export const CustomerSessionProvider = CustomerSessionContext.Provider;

export function useCustomerSession(): CustomerSession {
  return useContext(CustomerSessionContext);
}
