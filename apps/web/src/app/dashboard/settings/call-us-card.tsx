'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProfile, updateProfile } from '@/lib/vendor-api';
import { setDraftDirty, storeKey } from '@/lib/store-scope';

const DRAFT = 'Number customers can call';

type ProfileStores = { vendors?: Array<{ id: string; publicPhone?: string | null; goLive?: { steps?: string[] } | null }>; myRole?: string };

/**
 * [REVIEW-F #2220 S3-1] The number customers can call (the phone's "Your call-us number" card, its words): shown on
 * the store's page so a customer can call before ordering, and the one thing a waiting store needs from its owner to
 * go live (besides its documents and, for a restaurant, the food handlers tick). It is NOT the number the owner
 * signs in with, which stays private. Owner and managers (the API's own rule); the server judges the number (a
 * complete +592 line) and its refusal is shown in its own words. Empty takes it down.
 */
export function CallUsCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const data = profile.data as ProfileStores | undefined;
  const store = data?.vendors?.find((v) => v.id === storeId) ?? (data?.vendors?.length === 1 ? data.vendors[0] : undefined);
  const current = store?.publicPhone ?? '';
  const [text, setText] = useState(current);
  const [saved, setSaved] = useState(false);
  useEffect(() => setText(current), [current]);
  const dirty = text.trim() !== current;
  useEffect(() => {
    setDraftDirty(DRAFT, dirty);
    return () => setDraftDirty(DRAFT, false);
  }, [dirty]);

  const save = useMutation({
    mutationFn: () => updateProfile({ publicPhone: text.trim() || null }),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') });
      void queryClient.invalidateQueries({ queryKey: ['stores'] });
    },
  });

  if (!store || (data?.myRole !== 'OWNER' && data?.myRole !== 'MANAGER')) return null;
  const needed = store.goLive?.steps?.includes('PUBLISHED_PHONE') === true;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">Your call-us number</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        Customers see this on your store page and can call before they order. Your landline or your mobile — whichever
        you actually answer. This is separate from the number you sign in with, which stays private.
      </p>
      {needed && <p role="status" className="mt-2 text-sm font-semibold">This store goes live only once it has a number customers can call.</p>}
      <label htmlFor="call-us" className="sr-only">Your call-us number</label>
      <input
        id="call-us"
        inputMode="tel"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="+592 225 1234"
        className="mt-3 w-full rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm focus:border-[var(--swift-red)] focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : text.trim() || !current ? 'Save number' : 'Remove number'}
        </button>
        {saved && <span className="text-sm font-medium text-green-600" role="status">Saved ✓</span>}
      </div>
      {save.isError && <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{(save.error as Error).message}</p>}
    </div>
  );
}
