'use client';

import { useQuery } from '@tanstack/react-query';
import { getRiderProfile } from '@/lib/mover-api';
import { PartnerDocuments } from '@/components/partner-documents';

/**
 * A mover's documents. The checklist follows the saved vehicle; each document
 * shows where it stands, the reviewer's reason when one was turned down, and
 * an upload for that document alone, offered only when the server accepts one
 * (components/partner-documents.tsx).
 */
export default function DocumentsPage() {
  const rider = useQuery({ queryKey: ['p-rider'], queryFn: getRiderProfile, retry: 0 });
  const vehicleType = (rider.data?.['vehicleType'] as string | undefined) ?? undefined;

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold">Documents</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          Upload renewals on a big screen — reviews usually finish within 24 hours. An expired document takes you
          offline until it is renewed.
        </p>
      </div>
      <PartnerDocuments role="MOVER" vehicleType={vehicleType} ready={!rider.isLoading} helpTopic="MOVER" />
    </div>
  );
}
