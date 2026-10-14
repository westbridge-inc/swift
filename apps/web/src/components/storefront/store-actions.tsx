'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Heart, Share2 } from 'lucide-react';
import { useCustomerSession } from '@/components/customer-session';
import { accountApi } from '@/components/account/account-api';
import { useAccountQuery } from '@/components/account/account-frame';
import { signInPath } from '@/lib/customer-routes';
import styles from './storefront.module.css';

/**
 * [W6] The store's heart and share buttons, carried over from the old store
 * page so the one store page keeps them.
 *
 * The heart is the account's favourites list — the SAME query Account's
 * Favourites page reads (one key, never cached as fresh), so a change made
 * there is the state shown here. The write is chosen from the list read NOW,
 * never from a cached one: a stale "saved" would send a removal for a store
 * the person meant to save.
 */
export function StoreActions({ vendorId, slug, name, onMessage }: {
  vendorId: string;
  slug: string;
  name: string;
  onMessage: (_message: string) => void;
}) {
  const router = useRouter();
  const session = useCustomerSession();
  const queryClient = useQueryClient();
  const favourites = useAccountQuery('favourites', accountApi.favourites);
  const signedIn = session.status === 'signed-in';
  const saved = Boolean(favourites.data?.some((favourite) => favourite.id === vendorId));
  const [saving, setSaving] = useState(false);
  const storePath = `/store/${encodeURIComponent(slug)}`;

  async function toggleFavourite() {
    if (saving) return;
    if (!(await session.ensureSignedIn())) { router.push(signInPath(storePath)); return; }
    const wantSaved = !saved;
    setSaving(true);
    try {
      const fresh = await favourites.refetch();
      if (fresh.isError || !fresh.data) throw new Error('Could not check your favourites. Try again.');
      const isSaved = fresh.data.some((favourite) => favourite.id === vendorId);
      if (isSaved !== wantSaved) {
        await accountApi.favourite(vendorId, isSaved);
        await queryClient.invalidateQueries({ queryKey: ['account'] });
      }
      onMessage(wantSaved ? 'Saved to favourites' : 'Removed from favourites');
    } catch (error) {
      onMessage(error instanceof Error && error.message ? error.message : 'Could not update your favourites');
    } finally {
      setSaving(false);
    }
  }

  async function shareStore() {
    const url = `${window.location.origin}${storePath}`;
    try {
      if (navigator.share) { await navigator.share({ title: name, url }); return; }
      await navigator.clipboard.writeText(url);
      onMessage('Link copied');
    } catch { /* the person closed the share sheet */ }
  }

  return (
    <div className={styles.storeActions}>
      <button
        type="button"
        className={styles.iconButton}
        onClick={() => void toggleFavourite()}
        disabled={saving || (signedIn && favourites.isFetching)}
        aria-pressed={saved}
        aria-label={saved ? 'Remove from favourites' : 'Save to favourites'}
      >
        <Heart size={20} className={saved ? styles.heartOn : undefined} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" />
      </button>
      <button type="button" className={styles.iconButton} onClick={() => void shareStore()} aria-label="Share">
        <Share2 size={20} aria-hidden="true" />
      </button>
    </div>
  );
}
