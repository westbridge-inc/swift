'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProfile, removeStorePhoto, uploadStorePhoto } from '@/lib/vendor-api';
import { storeKey } from '@/lib/store-scope';
import { photo } from '@/lib/media';

type Slot = 'logo' | 'cover';
type ProfileStores = { vendors?: Array<{ id: string; logoUrl?: string | null; coverImageUrl?: string | null }>; myRole?: string };

const SLOTS: { slot: Slot; field: 'logoUrl' | 'coverImageUrl'; title: string; sub: string }[] = [
  { slot: 'cover', field: 'coverImageUrl', title: 'Cover photo', sub: 'Leads your store page and your card in lists.' },
  { slot: 'logo', field: 'logoUrl', title: 'Logo', sub: 'Sits beside your store name.' },
];

/** The API's own refusal, in its words. */
function serverWords(e: unknown, fallback: string): string {
  const message = (e as { message?: unknown })?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

/**
 * [IMAGES-E2E] The store's own logo and cover photo, the same as the phone app's Account
 * screen. The photo is sent as chosen; the API checks it is a JPEG, PNG or WebP photo,
 * scans it, redraws it WITHOUT the camera's data (location, device, time) and keeps it
 * where customers' apps and the website load it. Store managers only (the API refuses
 * anyone else).
 */
export function StorePhotosCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const data = profile.data as ProfileStores | undefined;
  const store = data?.vendors?.find((v) => v.id === storeId) ?? (data?.vendors?.length === 1 ? data.vendors[0] : undefined);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Record<Slot, HTMLInputElement | null>>({ logo: null, cover: null });

  const refresh = () => queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') });
  const upload = useMutation({
    mutationFn: ({ slot, file }: { slot: Slot; file: File }) => uploadStorePhoto(slot, file),
    onMutate: () => setError(null),
    onSuccess: () => { void refresh(); },
    onError: (e) => setError(serverWords(e, "That photo didn't upload. Try again.")),
  });
  const remove = useMutation({
    mutationFn: (slot: Slot) => removeStorePhoto(slot),
    onMutate: () => setError(null),
    onSuccess: () => { void refresh(); },
    onError: (e) => setError(serverWords(e, "That photo couldn't be removed. Try again.")),
  });
  if (!store) return null;
  const working = (slot: Slot) => (upload.isPending && upload.variables?.slot === slot) || (remove.isPending && remove.variables === slot);

  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">Store photos</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        Customers see these in the app and on the website. Location and camera details are removed.
      </p>
      <div className="mt-4 space-y-4">
        {SLOTS.map(({ slot, field, title, sub }) => {
          const current = store[field] ?? null;
          const shown = photo(current);
          return (
            <div key={slot} className="flex items-center gap-4">
              <div className={`relative h-14 shrink-0 overflow-hidden bg-[var(--swift-surface-subtle,#f4f4f5)] ${slot === 'logo' ? 'w-14 rounded-full' : 'w-24 rounded-lg'}`}>
                {shown ? <Image {...shown} alt={title} fill sizes={slot === 'logo' ? '56px' : '96px'} className="object-cover" /> : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{title}</p>
                <p className="text-xs text-[var(--swift-muted)]">{sub}</p>
                <div className="mt-1 flex gap-4 text-sm">
                  <button
                    type="button"
                    className="font-semibold text-[var(--swift-brand,#0a7d4f)] disabled:opacity-50"
                    disabled={working(slot)}
                    onClick={() => inputs.current[slot]?.click()}
                  >
                    {working(slot) ? 'Working…' : current ? 'Change' : 'Add photo'}
                  </button>
                  {current && !working(slot) ? (
                    <button type="button" className="text-[var(--swift-muted)]" onClick={() => remove.mutate(slot)}>
                      Remove
                    </button>
                  ) : null}
                </div>
                <input
                  ref={(el) => { inputs.current[slot] = el; }}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  aria-label={`${title} file`}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) upload.mutate({ slot, file });
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {error ? <p role="alert" className="mt-3 text-sm font-semibold text-[var(--swift-red)]">{error}</p> : null}
    </div>
  );
}
