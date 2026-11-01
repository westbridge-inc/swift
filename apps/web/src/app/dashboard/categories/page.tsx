'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { getCategorySuggestions, resolveCategorySuggestion, type CategoryGroup } from '@/lib/store-extras-api';
import { DataUnavailable } from '@/components/data-unavailable';
import { CATEGORY_WORDS } from './category-words';


/**
 * [WEB-SETTINGS PR-B · owner 31 Oct 2026] "Review your categories" on the website: the phone's
 * VendorCategoryReviewScreen, with the same calls (GET /vendor/category-suggestions, POST .../:id/accept|dismiss;
 * manager and owner on the server). Grouped by item, the matcher's order kept. Both answers are final on the server,
 * so each button is one tap and the page says so.
 */
export default function CategoriesPage() {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const { manager, known, failed } = useStoreRole();
  const key = storeKey(storeId, 'category-suggestions');
  const q = useQuery({ queryKey: key, queryFn: getCategorySuggestions, enabled: manager });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // [REVIEW-F #2281 S4-2] An answer removes its row: focus goes to what happened, never to the top of the page.
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);

  const resolve = useMutation({
    mutationFn: (v: { id: string; action: 'accept' | 'dismiss'; name: string }) => resolveCategorySuggestion(v.id, v.action),
    onMutate: () => setNotice(null),
    onSuccess: (_r, v) => setNotice({ ok: true, text: v.action === 'accept' ? `Added to ${v.name}` : 'Suggestion dismissed' }),
    onError: (e) => setNotice({ ok: false, text: (e as Error)?.message || CATEGORY_WORDS.failed }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: key }); },
  });

  if (known && !manager) return <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">{CATEGORY_WORDS.staff}</p>;

  const groups: CategoryGroup[] = q.data ?? [];
  const total = groups.reduce((n, g) => n + g.suggestions.length, 0);
  const act = (id: string, action: 'accept' | 'dismiss', name: string) => { if (!resolve.isPending) resolve.mutate({ id, action, name }); };

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link href="/dashboard/settings" className="text-sm font-semibold text-[var(--swift-muted)] hover:underline">Back to settings</Link>
        <h1 className="sw-title mt-2">Review your categories</h1>
        <p className="sw-caption mt-1">
          {total > 0
            ? `${total} suggestion${total === 1 ? '' : 's'} across ${groups.length} item${groups.length === 1 ? '' : 's'}. Customers browse the Market by category, so a listing with none is harder to find.`
            : CATEGORY_WORDS.browse}
        </p>
      </div>

      {notice && (
        <p ref={noticeRef} tabIndex={-1} role={notice.ok ? 'status' : 'alert'} className={`text-sm font-semibold ${notice.ok ? 'text-green-700' : 'text-[var(--swift-red)]'}`}>{notice.text}</p>
      )}

      {failed ? (
        // [REVIEW-F #2281 S4-1] The role could not be read: say so, never "Checking…" for ever.
        <DataUnavailable what="your store details" onRetry={() => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'my-role') })} />
      ) : q.isError ? (
        <DataUnavailable what="your category suggestions" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <p role="status" className="sw-card p-6 text-sm text-[var(--swift-muted)]">Checking your listings…</p>
      ) : groups.length === 0 ? (
        <div className="sw-card p-6">
          <h2 className="font-bold">{CATEGORY_WORDS.emptyTitle}</h2>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">{CATEGORY_WORDS.emptyBody}</p>
        </div>
      ) : (
        <>
          <ul className="space-y-4">
            {groups.map((group) => (
              <li key={group.itemId} className="sw-card p-5">
                <p className="break-words font-semibold">{group.itemName}</p>
                {group.suggestions.map((s) => (
                  <div key={s.id} className="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--swift-border)] pt-3">
                    <span className="min-w-0 flex-1 text-sm">{s.name}</span>
                    <button
                      type="button"
                      className="sw-chip min-h-11"
                      disabled={resolve.isPending}
                      aria-label={`Not this: ${s.name} for ${group.itemName} — dismiss this suggestion`}
                      onClick={() => act(s.id, 'dismiss', s.name)}
                    >
                      Not this
                    </button>
                    <button
                      type="button"
                      className="min-h-11 rounded-full bg-[var(--swift-red)] px-4 text-sm font-semibold text-white disabled:opacity-50"
                      disabled={resolve.isPending}
                      aria-label={`Yes, ${group.itemName} is ${s.name}`}
                      onClick={() => act(s.id, 'accept', s.name)}
                    >
                      Yes
                    </button>
                  </div>
                ))}
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--swift-muted)]">{CATEGORY_WORDS.final}</p>
        </>
      )}
    </div>
  );
}
