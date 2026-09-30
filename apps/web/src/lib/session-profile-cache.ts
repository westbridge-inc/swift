'use client';

import { isCancelledError, QueryClient } from '@tanstack/react-query';
import { getSessionPrincipal, sessionProbe, subscribeSession } from './auth';
import type { Profile } from '@/components/account/account-api';

// Shared by account/profile reads without changing the parity lane's query
// wrapper. Browser memory only; every auth transition clears it synchronously.
let cache: QueryClient | undefined;
let epoch = 0;
let replacement: { principal: string; epoch: number; profile: Profile } | undefined;
function profileCache() {
  if (!cache) {
    cache = new QueryClient();
    subscribeSession(() => { epoch += 1; replacement = undefined; cache?.clear(); });
  }
  return cache;
}
const key = () => ['session-profile', getSessionPrincipal(), epoch] as const;

async function readForPrincipal(read: () => Promise<Profile>, principal: string | null): Promise<Profile> {
  const profile = await read();
  // Cookies may have changed without a delivered notification. Never label a
  // fresh response for B with the stale A key: it could later be reused by A.
  if (profile.id !== principal) {
    await sessionProbe();
    throw new Error('The signed-in account changed. Please try again.');
  }
  return profile;
}

export async function readSessionProfile(read: () => Promise<Profile>): Promise<Profile> {
  if (typeof window === 'undefined' || !getSessionPrincipal()) return read();
  const client = profileCache();
  const previousWrite = replacement;
  // A cached name/phone is never proof of who owns the current cookies. Even
  // when a suspended tab missed both transports, /auth/me must attest to the
  // same identity before memory can answer. A fresh GET remains authoritative.
  if (client.getQueryState(key()) !== undefined) {
    const session = await sessionProbe();
    if (!session.ok || session.user?.['id'] !== getSessionPrincipal()) {
      epoch += 1;
      replacement = undefined;
      client.clear();
      return read();
    }
  }
  const queryKey = key();
  const superseded = () => replacement && replacement !== previousWrite && replacement.epoch === queryKey[2]
    && replacement.principal === queryKey[1] && epoch === queryKey[2] && getSessionPrincipal() === queryKey[1];
  if (superseded()) return replacement!.profile;
  try {
    const profile = await client.fetchQuery({ queryKey, queryFn: () => readForPrincipal(read, queryKey[1]), staleTime: 60_000, gcTime: 5 * 60_000, retry: false });
    return superseded() ? replacement!.profile : profile;
  } catch (error) {
    // A successful save supersedes an older GET. Its observer must receive
    // the saved profile, rather than turn cancellation into an error screen.
    if (isCancelledError(error) && superseded()) {
      return replacement!.profile;
    }
    throw error;
  }
}

export async function writeSessionProfile(write: () => Promise<Profile>): Promise<Profile> {
  const client = profileCache();
  const queryKey = key();
  const profile = await write();
  if (queryKey[1] && profile.id !== queryKey[1]) {
    await sessionProbe();
    throw new Error('The signed-in account changed. Please try again.');
  }
  if (queryKey[1] && queryKey[1] === getSessionPrincipal() && queryKey[2] === epoch) {
    replacement = { principal: queryKey[1], epoch, profile };
    await client.cancelQueries({ queryKey, exact: true });
    if (queryKey[1] === getSessionPrincipal() && queryKey[2] === epoch) client.setQueryData(queryKey, profile);
  }
  return profile;
}
