'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getProfile } from '@/lib/vendor-api';
import { getStoreVatStatus } from '@/lib/vat-report';
import { DataUnavailable } from '@/components/data-unavailable';
import { storeKey } from '@/lib/store-scope';

/** Statuses under which the store's orders may have carried VAT: approved now, or approved before it was withdrawn. */
const HAD_VAT = new Set(['APPROVED', 'REVOKED']);

/**
 * [STORE-VAT · owner O-5 · PR4] The way to the store's VAT report, for an owner whose store has had VAT (a person
 * approved its GRA certificate). Hidden for every other store and for staff.
 */
export function VatReportLink({ storeId }: { storeId: string | null }) {
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const isOwner = (profile.data as { myRole?: string } | undefined)?.myRole === 'OWNER';
  const status = useQuery({ queryKey: storeKey(storeId, 'vat-status'), queryFn: getStoreVatStatus, enabled: isOwner });
  if (!isOwner) return null;
  if (status.isError) return <DataUnavailable what="your VAT settings" error={status.error} onRetry={() => void status.refetch()} />;
  if (!status.data || !HAD_VAT.has(status.data)) return null;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">VAT report</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        Your sales through Swift that carried VAT, month by month, for your accountant. Swift does not file your VAT return.
      </p>
      <Link href="/dashboard/settings/vat-report" className="mt-3 inline-block text-sm font-semibold text-[var(--swift-red)] hover:underline">
        Open your VAT report
      </Link>
    </div>
  );
}
