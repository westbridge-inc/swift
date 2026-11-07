'use client';

import type { DocStatus } from '@/lib/mover-api';
import { isTaxiChecklist } from '@/lib/taxi-documents';
import {
  OPTIONAL_HEADING, OPTIONAL_INTRO, POLICE_CLEARANCE_DOC, POLICE_CLEARANCE_NO_WORDS, docLabel, latestDocument, optionalDocHint, optionalDocTypes,
  policeClearanceWordsFrom,
} from '@/lib/store-documents';
import { DocumentCard } from '@/app/dashboard/documents/document-card';

/**
 * [POLICE-CLEARANCE CONSENT · owner 31 Oct 2026] A TAXI driver's optional police clearance (an approved, current one
 * records the account as police-cleared; it never gates), on the phone's card with its OWN consent in the API's words —
 * never under the privacy-notice tick of the list. A delivery rider is never offered one, whatever a list says.
 * [PERF · REVIEW-F S2-1] Loaded on demand by the Documents page (only for a taxi checklist that offers it), so the card
 * and the phone's word modules stay out of the page's first load.
 */
export default function PoliceClearanceSection({ status, onSent }: { status: DocStatus; onSent: () => void }) {
  const offersPolice = isTaxiChecklist(status.checklist ?? []) && optionalDocTypes(status).includes(POLICE_CLEARANCE_DOC);
  if (!offersPolice) return null;
  const policeWords = policeClearanceWordsFrom(status);
  return (
    <section aria-labelledby="documents-optional" className="space-y-3">
      <div>
        <h2 id="documents-optional" className="text-lg font-bold">{OPTIONAL_HEADING}</h2>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">{OPTIONAL_INTRO}</p>
      </div>
      {policeWords ? (
        <DocumentCard
          role="MOVER"
          docType={POLICE_CLEARANCE_DOC}
          doc={latestDocument(status.documents, POLICE_CLEARANCE_DOC)}
          isNext={false}
          optionalHint={optionalDocHint(POLICE_CLEARANCE_DOC)}
          consented={false}
          consentVia="checkbox"
          policeConsent={policeWords}
          onSent={onSent}
        />
      ) : (
        <div className="sw-card p-5">
          <p className="font-semibold">{docLabel(POLICE_CLEARANCE_DOC)}</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">{POLICE_CLEARANCE_NO_WORDS}</p>
        </div>
      )}
    </section>
  );
}
