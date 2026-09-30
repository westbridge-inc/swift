'use client';

import { isCancelledError, QueryClient } from '@tanstack/react-query';
import { getSessionPrincipal, subscribeSession } from './auth';
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

export async function readSessionProfile(read: () => Promise<Profile>): Promise<Profile> {
  if (typeof window === 'undefined' || !getSessionPrincipal()) return read();
  const client = profileCache();
  const queryKey = key();
  const previousWrite = replacement;
  const superseded = () => replacement && replacement !== previousWrite && replacement.epoch === queryKey[2]
    && replacement.principal === queryKey[1] && epoch === queryKey[2] && getSessionPrincipal() === queryKey[1];
  try {
    const profile = await client.fetchQuery({ queryKey, queryFn: read, staleTime: 60_000, gcTime: 5 * 60_000, retry: false });
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
  if (queryKey[1] && queryKey[1] === getSessionPrincipal() && queryKey[2] === epoch) {
    replacement = { principal: queryKey[1], epoch, profile };
    await client.cancelQueries({ queryKey, exact: true });
    if (queryKey[1] === getSessionPrincipal() && queryKey[2] === epoch) client.setQueryData(queryKey, profile);
  }
  return profile;
}
