'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProfile, updateProfile } from '@/lib/vendor-api';
import { setDraftDirty, storeKey } from '@/lib/store-scope';
import { DataUnavailable } from '@/components/data-unavailable';
import { site } from '@/site.config';
import { selectedProfileStore, storeCheckLabel, type ProfileData, type ProfileStore } from './store-check';

/** The server's refusal of a rename for a store trading under the owner's own name (vendor.routes.ts OWN_NAME_RENAME). */
export const OWN_NAME_RENAME_WORDS = 'This store trades under your own name, which a person checked. To use a different name, register it as a business name first, then switch the store to it under Documents.';
/** [WEB-SETTINGS ruling] A store a person checked keeps the name it was checked under: the server would not check a new one again. */
export const checkedNameWords = (email: string) => `A person checked your store under this name, so it is not changed here: a new name needs Swift to check it again. Email ${email} to change it.`;
export const STORE_DETAILS_OWNER_ONLY = 'Only the store owner can change the store’s name, description and address.';
const NAME_WORDS = 'Enter the store’s name: 2 to 100 characters.';
const DRAFT = 'Store name and description';
const DESCRIPTION_MAX = 2000;

type DetailsStore = ProfileStore & {
  tradesUnderOwnName?: boolean;
  storeCheck?: { status?: string; message?: string } | null;
};

const typeWord = (t: string) => (t === 'SUPERMARKET' ? 'Grocery' : t === 'STORE' ? 'Shop' : t === 'SERVICE' ? 'Services' : 'Restaurant');

/**
 * [WEB-SETTINGS · owner 31 Oct 2026] The store's name and description, on the website. Partners have no app yet, and
 * the phone has no editor for them either (this card used to say they were "edited in the Swift app"). The OWNER edits
 * them (stricter than the API, which lets a manager: the store's name is the business's to give); the change goes out
 * as PUT /vendor/profile with only what changed. The server judges the words: a store trading under the owner's own
 * name keeps it (a person checked it as that name), a "TEST-" name is refused, and words that mention goods Swift
 * doesn't carry wait for a person, which this card then says in the server's own words. A store a person already
 * checked keeps its name here (WEB-SETTINGS ruling): the server would not check a new name again.
 */
export function StoreDetailsCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const data = profile.data as (ProfileData & { myRole?: string }) | undefined;
  const p = selectedProfileStore(data, storeId) as DetailsStore | undefined;
  const role = data?.myRole;
  const owner = role === 'OWNER';
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Own name: the server refuses a rename (OWN_NAME_RENAME). Checked: a person checked the store under this name, and
  // the server does not check a new name again (only words about goods Swift doesn't carry wait for a person).
  const nameLocked = !!p?.tradesUnderOwnName || !!p?.isVerified;
  const changes: Record<string, string> = {};
  if (p && editing) {
    if (!nameLocked && name.trim() !== p.name) changes['name'] = name.trim();
    if (description.trim() !== (p.description ?? '').trim()) changes['description'] = description.trim();
  }
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => {
    setDraftDirty(DRAFT, dirty);
    return () => setDraftDirty(DRAFT, false);
  }, [dirty]);

  const save = useMutation({
    mutationFn: (body: Record<string, string>) => updateProfile(body),
    onMutate: () => { setError(null); setSaved(null); },
    onSuccess: (res) => {
      const check = (res as { data?: { storeCheck?: { status?: string; message?: string } | null } } | undefined)?.data?.storeCheck;
      setEditing(false);
      setSaved(check?.status === 'WAITING_FOR_CHECK' && check.message ? check.message : 'Saved ✓');
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') });
      void queryClient.invalidateQueries({ queryKey: ['stores'] });
    },
    onError: (e) => setError(e instanceof Error && e.message ? e.message : 'The details could not be saved. Try again.'),
  });

  if (profile.isError) return <DataUnavailable what="your store details" error={profile.error} onRetry={() => void profile.refetch()} />;
  if (!p) return null;
  const waiting = p.storeCheck?.status === 'WAITING_FOR_CHECK' && p.storeCheck.message ? p.storeCheck.message : null;

  const open = () => {
    setName(p.name);
    setDescription(p.description ?? '');
    setError(null);
    setSaved(null);
    setEditing(true);
  };
  const submit = () => {
    if (!dirty || save.isPending) return;
    if (changes['name'] !== undefined && (changes['name'].length < 2 || changes['name'].length > 100)) {
      setError(NAME_WORDS);
      return;
    }
    save.mutate(changes);
  };

  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">{p.name}</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        {typeWord(p.vendorType)}
        {p.city ? ` · ${p.city}` : ''} · {storeCheckLabel(p)}
      </p>
      {p.description && <p className="mt-2 text-sm">{p.description}</p>}
      {waiting && saved !== waiting && <p role="status" className="mt-3 text-sm font-semibold">{waiting}</p>}
      {saved && <p role="status" className={`mt-3 text-sm ${saved === 'Saved ✓' ? 'font-medium text-green-600' : 'font-semibold'}`}>{saved}</p>}

      {owner && !editing && (
        <button type="button" onClick={open} className="sw-chip mt-3">Edit name and description</button>
      )}
      {owner && editing && (
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-semibold">
            Store name
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              disabled={nameLocked}
              maxLength={100}
              aria-describedby={nameLocked ? 'store-name-locked' : undefined}
              className="mt-1 w-full rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm font-normal disabled:opacity-60"
            />
          </label>
          {nameLocked && (
            <p id="store-name-locked" className="text-xs text-[var(--swift-muted)]">
              {p.tradesUnderOwnName ? OWN_NAME_RENAME_WORDS : checkedNameWords(site.supportEmail)}
            </p>
          )}
          <label className="block text-sm font-semibold">
            Description
            <textarea
              value={description}
              onChange={(e) => { setDescription(e.target.value); setError(null); }}
              maxLength={DESCRIPTION_MAX}
              rows={3}
              className="mt-1 w-full rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm font-normal"
            />
          </label>
          <p className="text-xs text-[var(--swift-muted)]">Customers see these on your store page. Swift checks a store’s words against the goods it doesn’t carry.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={!dirty || save.isPending}
              className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save details'}
            </button>
            <button type="button" onClick={() => { setEditing(false); setError(null); }} disabled={save.isPending} className="px-2 text-sm font-semibold text-[var(--swift-muted)]">
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{error}</p>}
      {role === 'MANAGER' && <p className="mt-3 text-xs text-[var(--swift-muted)]">{STORE_DETAILS_OWNER_ONLY}</p>}
    </div>
  );
}
