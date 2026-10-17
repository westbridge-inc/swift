'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProfile, updateProfile } from '@/lib/vendor-api';
import { setDraftDirty, storeKey } from '@/lib/store-scope';

/** The refund rule's limit, as the API checks it (vendor/refund-rule.ts). */
export const REFUND_RULE_MAX = 300;
const DRAFT = 'Refund rule';

type ProfileStores = { vendors?: Array<{ id: string; refundRule?: string | null }>; myRole?: string };

/**
 * [R3 · Consumer Affairs Act 2011 s.70(3)] The store's own refund rule: what its storefront shows under "Refunds",
 * followed by the customer's statutory rights. The owner's to give (the API refuses anyone else), in plain words;
 * empty takes it down and the storefront says "Ask the store". The server judges the words (length, no links, no
 * goods Swift never carries) and its refusal is shown in its own words.
 */
export function RefundRuleCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const data = profile.data as ProfileStores | undefined;
  const store = data?.vendors?.find((v) => v.id === storeId) ?? (data?.vendors?.length === 1 ? data.vendors[0] : undefined);
  const current = store?.refundRule ?? '';
  const [text, setText] = useState(current);
  const [saved, setSaved] = useState(false);
  useEffect(() => setText(current), [current]);
  const dirty = text.trim() !== current;
  useEffect(() => {
    setDraftDirty(DRAFT, dirty);
    return () => setDraftDirty(DRAFT, false);
  }, [dirty]);

  const save = useMutation({
    mutationFn: () => updateProfile({ refundRule: text.trim() || null }),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') });
    },
  });

  if (!store || data?.myRole !== 'OWNER') return null;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">Your refund rule</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        Customers see this on your store page under &ldquo;Refunds&rdquo;, followed by their rights under the Consumer
        Affairs Act 2011. Leave it empty and your page says &ldquo;Ask the store&rdquo;.
      </p>
      <label htmlFor="refund-rule" className="sr-only">Your refund rule</label>
      <textarea
        id="refund-rule"
        value={text}
        maxLength={REFUND_RULE_MAX}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="For example: Bring it back within 3 days with your receipt for a refund or exchange."
        className="mt-3 w-full rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm focus:border-[var(--swift-red)] focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : text.trim() || !current ? 'Save refund rule' : 'Remove refund rule'}
        </button>
        <span className="text-xs text-[var(--swift-muted)]">{text.trim().length}/{REFUND_RULE_MAX}</span>
        {saved && <span className="text-sm font-medium text-green-600" role="status">Saved ✓</span>}
      </div>
      {save.isError && (
        <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{(save.error as Error).message}</p>
      )}
    </div>
  );
}
