import { beforeEach, expect, it, vi } from 'vitest';
import { adoptSession, clearSession } from './auth';
import { readSessionProfile, writeSessionProfile } from './session-profile-cache';
import type { Profile } from '@/components/account/account-api';

const profile = (id: string, firstName = id): Profile => ({ id, firstName, lastName: 'Test', phone: '+5920000000', email: null });
const deferred = () => {
  let resolve!: (_value: Profile) => void;
  const promise = new Promise<Profile>((done) => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => {
  adoptSession('a');
  // Cache reuse now requires the real server identity endpoint as well as the
  // profile reader. Keep every existing reuse/save-race assertion unchanged.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { user: { id: 'a' } } }))));
});

it('deduplicates concurrent reads and reuses only the current session profile', async () => {
  const pending = deferred();
  const read = vi.fn(() => pending.promise);
  const first = readSessionProfile(read);
  const second = readSessionProfile(read);
  pending.resolve(profile('a'));
  expect(await first).toEqual(await second);
  await readSessionProfile(read);
  expect(read).toHaveBeenCalledTimes(1);
  clearSession(); adoptSession('a');
  await readSessionProfile(read);
  expect(read).toHaveBeenCalledTimes(2);
});

it('an old session write cannot seed the profile cache after signing back in as the same person', async () => {
  const pending = deferred();
  const saving = writeSessionProfile(() => pending.promise);
  clearSession(); adoptSession('a');
  const read = vi.fn(async () => profile('a', 'Current'));
  await readSessionProfile(read);
  pending.resolve(profile('a', 'Old'));
  await saving;
  expect((await readSessionProfile(read)).firstName).toBe('Current');
  expect(read).toHaveBeenCalledTimes(1);
});

it.each([false, true])('a delayed read resolves the successful write, with prior cache %s', async (cached) => {
  if (cached) {
    await readSessionProfile(async () => profile('a', 'Previously cached'));
    const later = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
  }
  const pending = deferred();
  const reading = readSessionProfile(() => pending.promise);
  await writeSessionProfile(async () => profile('a', 'Updated'));
  pending.resolve(profile('a', 'Old'));
  expect((await reading).firstName).toBe('Updated');
  expect((await readSessionProfile(async () => profile('a', 'Unexpected'))).firstName).toBe('Updated');
});

it('does not cache a guest read', async () => {
  clearSession();
  const read = vi.fn(async () => profile('guest'));
  await readSessionProfile(read); await readSessionProfile(read);
  expect(read).toHaveBeenCalledTimes(2);
});
