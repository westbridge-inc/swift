'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { DataUnavailable } from '@/components/data-unavailable';
import { LEGAL_URL } from '@/lib/legal-url';
import { storeKey } from '@/lib/store-scope';
import { getStoreDocumentStatus, type StoreUploadConsentVia } from '@/lib/store-documents-api';
import { getStoreVat } from '@/lib/store-vat-read';
import { VAT_DOCUMENT_ROW } from '@/lib/store-vat-words';
import {
  DOCUMENT_CONSENT_TEXT, DOCUMENT_PHOTO_HINT, DOCUMENT_REVIEW_PROMISE, DOCUMENTS_FOOTNOTE, FOOD_HANDLERS_DOC, OPTIONAL_HEADING, OPTIONAL_INTRO,
  OWN_NAME_DOC, POLICE_CLEARANCE_DOC, POLICE_CLEARANCE_HOME_VISITS, POLICE_CLEARANCE_NO_WORDS, POLICE_CLEARANCE_STORE_TYPES, REQUIRED_HEADING,
  REQUIRED_INTRO, docLabel, documentConsentGivenLine, documentConsentOnRecord, emptyChecklistCopy, latestDocument, optionalDocHint,
  optionalDocTypes, ownNameApplies, policeClearanceWordsFrom, vatDocumentStatusWord,
} from '@/lib/store-documents';
import { FoodHandlersCard } from '../settings/food-handlers-card';
import { StoreFeeCard } from '../settings/store-fee-card';
import { DocumentCard } from './document-card';
import { OwnNameCard } from './own-name-card';

/** The consent words as the person reads them, with "privacy notice" opening the notice (as the rider page). */
const [CONSENT_BEFORE, CONSENT_AFTER] = DOCUMENT_CONSENT_TEXT.split('privacy notice') as [string, string];

/**
 * [OPEN-EARLY PR-2] The phone's DocumentChecklist for a store, on the website: GET /verification/status?role=<store
 * type>, honest about every state (a failed read is never "nothing required"). The required steps with one consent
 * tick above them (the person's own: given on this visit, or their grant the ledger holds), the progress, each
 * document's card, the food handlers tick and the weekly-fee tick where the phone draws them, the own-name choices,
 * then the optional documents (the VAT certificate row among them). [POLICE-CLEARANCE CONSENT] A Services business's
 * police clearance is sent on its own card with its OWN consent, in the API's words (lib/store-documents): never under
 * the tick above; any other store is never offered one.
 */
export function StoreDocumentChecklist({ storeId, vendorType, storeName }: { storeId: string; vendorType: string; storeName: string }) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: storeKey(storeId, 'documents', vendorType), queryFn: () => getStoreDocumentStatus(vendorType) });
  // [VAT-DOCS] the optional "VAT certificate (only if VAT-registered)" row reads the store's VAT (the owner's read, as the VAT card)
  const vat = useQuery({ queryKey: storeKey(storeId, 'vat'), queryFn: getStoreVat });
  // [DOC-CONSENT · owner 25 Oct 2026] The tick is the person's own: the one given on this visit, else their grant on record.
  const [choice, setChoice] = useState<boolean | null>(null);
  const d = status.data;
  const record = documentConsentOnRecord(d);
  const consented = choice ?? record.given;
  const recordLine = choice === null && record.given ? documentConsentGivenLine(record.givenAt) : null;
  const consentVia: StoreUploadConsentVia = choice === true ? 'checkbox' : 'record';
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'documents') });
    void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'food-handlers') });
    void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') });
    void queryClient.invalidateQueries({ queryKey: ['stores'] });
  };

  if (status.isError) return <DataUnavailable what="your verification steps" error={status.error} onRetry={() => void status.refetch()} />;
  if (!d) return <p role="status" className="text-sm text-[var(--swift-muted)]">Loading…</p>;

  const checklist = d.checklist ?? [];
  // [POLICE-CLEARANCE CONSENT] Only a Services business is offered a police clearance (SERVICE_OPTIONAL); any other
  // store type never sees one, whatever its list says. Its own consent is the API's words, or none is taken.
  const offersPolice = POLICE_CLEARANCE_STORE_TYPES.has(vendorType);
  const policeWords = offersPolice ? policeClearanceWordsFrom(d) : null;
  const optional = optionalDocTypes(d).filter((docType) => docType !== POLICE_CLEARANCE_DOC || offersPolice);
  const latest = (docType: string) => latestDocument(d.documents, docType);
  const nextDoc = checklist.find((dt) => latest(dt)?.status !== 'APPROVED');

  if (checklist.length === 0) {
    const copy = emptyChecklistCopy(d);
    return (
      <div className="sw-card p-6">
        <p className="font-semibold">{copy.title}</p>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">{copy.body}</p>
      </div>
    );
  }

  const approvedCount = checklist.filter((dt) => latest(dt)?.status === 'APPROVED').length;
  const allSubmitted = checklist.every((dt) => ['APPROVED', 'PENDING'].includes(latest(dt)?.status ?? ''));
  const v = vat.data;
  const vatRow = v && (v.available || v.status !== 'NONE') ? v : null;

  const card = (docType: string, isOptional: boolean) => {
    const doc = latest(docType);
    if (docType === POLICE_CLEARANCE_DOC && !policeWords) {
      return (
        <div key={docType} className="sw-card p-5">
          <p className="font-semibold">{docLabel(docType)}</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">{POLICE_CLEARANCE_NO_WORDS}</p>
        </div>
      );
    }
    return (
      <DocumentCard
        key={docType}
        role={vendorType}
        docType={docType}
        doc={doc}
        isNext={!isOptional && docType === nextDoc}
        optionalHint={isOptional ? optionalDocHint(docType) : undefined}
        // [VERIFY-DOCS] On the list (a business that offers home visits), it still never gates the store.
        hint={!isOptional && docType === POLICE_CLEARANCE_DOC ? POLICE_CLEARANCE_HOME_VISITS : undefined}
        consented={consented}
        consentVia={consentVia}
        policeConsent={docType === POLICE_CLEARANCE_DOC ? policeWords : null}
        onSent={refresh}
      />
    );
  };

  return (
    <div className="space-y-4">
      <section aria-labelledby="documents-required" className="space-y-3">
        <div>
          <h2 id="documents-required" className="text-lg font-bold">{REQUIRED_HEADING}</h2>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">{REQUIRED_INTRO}</p>
        </div>
        {/* [R17 · legal research D2/B1] a tick before any upload; the API records it in the consent ledger. */}
        <label className="flex items-start gap-3 rounded-2xl border border-[var(--swift-border)] p-4 text-sm">
          <input
            type="checkbox"
            checked={consented}
            onChange={() => setChoice((c) => !(c ?? record.given))}
            className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]"
            aria-describedby={recordLine ? 'document-consent-record' : undefined}
          />
          <span>
            <span className="text-[var(--swift-muted)]">
              {CONSENT_BEFORE}<a href={LEGAL_URL('privacy')} target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">privacy notice</a>{CONSENT_AFTER}
            </span>
            {recordLine && <span id="document-consent-record" className="mt-1 block text-xs text-[var(--swift-muted)]">{recordLine}</span>}
          </span>
        </label>
        <p className="text-xs text-[var(--swift-muted)]">{DOCUMENT_REVIEW_PROMISE} {DOCUMENT_PHOTO_HINT}</p>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs font-semibold text-[var(--swift-muted)]">
            <span>{approvedCount} of {checklist.length} approved</span>
            {allSubmitted && approvedCount < checklist.length && <span className="text-[var(--swift-red)]">All submitted — in review</span>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--swift-subtle)]" role="progressbar" aria-label="Documents approved" aria-valuemin={0} aria-valuemax={checklist.length} aria-valuenow={approvedCount}>
            <div className="h-1.5 rounded-full bg-[var(--swift-success)]" style={{ width: `${Math.round((approvedCount / checklist.length) * 100)}%` }} />
          </div>
        </div>
        {checklist.map((docType) => {
          // [FOOD-PERMIT · owner 24 Oct 2026] the food handlers step is a tick (the server's words), never an upload
          if (docType === FOOD_HANDLERS_DOC) return <FoodHandlersCard key={docType} storeId={storeId} isOwner vendorType={vendorType} />;
          const doc = latest(docType);
          // [ROLE-DOCS · owner 21 Oct 2026] the own-name declaration is signed, never uploaded
          if (docType === OWN_NAME_DOC) {
            return !doc || doc.status === 'REJECTED' ? (
              <div key={docType}>
                {doc && <p role="alert" className="text-sm text-[var(--swift-red)]">{doc.reviewNote ?? 'Your own-name declaration was not accepted.'}</p>}
                <OwnNameCard mode="sign" storeName={storeName} onDone={refresh} />
              </div>
            ) : (
              <div key={docType} className="sw-card p-5">
                <p className="font-semibold">I trade under my own name</p>
                <p className="mt-1 text-sm text-[var(--swift-muted)]">{doc.status === 'APPROVED' ? 'Checked by a person on our team.' : 'Signed — a person on our team is checking it against your ID.'}</p>
              </div>
            );
          }
          return card(docType, false);
        })}
      </section>

      {/* [RETIER PR-A2] a store whose fee follows its catalogue above the first step ticks it before it goes live */}
      <StoreFeeCard storeId={storeId} isOwner />
      {ownNameApplies(vendorType) && checklist.includes(OWN_NAME_DOC) && <OwnNameCard mode="drop" storeName={storeName} onDone={refresh} />}
      {ownNameApplies(vendorType) && checklist.includes('business_registration') && latest('business_registration')?.status !== 'APPROVED' && (
        <OwnNameCard mode="offer" storeName={storeName} onDone={refresh} />
      )}

      {(optional.length > 0 || vatRow) && (
        <section aria-labelledby="documents-optional" className="space-y-3">
          <div>
            <h2 id="documents-optional" className="text-lg font-bold">{OPTIONAL_HEADING}</h2>
            <p className="mt-1 text-sm text-[var(--swift-muted)]">{OPTIONAL_INTRO}</p>
          </div>
          {optional.map((docType) => card(docType, true))}
          {vatRow && (
            <div className="sw-card p-5">
              <div className="flex flex-wrap items-center gap-3">
                <p className="font-semibold">{VAT_DOCUMENT_ROW.title}</p>
                <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-xs font-bold text-[var(--swift-muted)]">{vatDocumentStatusWord(vatRow.status, vatRow.certificate?.status)}</span>
              </div>
              <p className="mt-1 text-sm text-[var(--swift-muted)]">{VAT_DOCUMENT_ROW.body}</p>
              <Link href="/dashboard/settings" className="sw-chip mt-3 inline-flex">Add it under VAT, in Account</Link>
            </div>
          )}
        </section>
      )}

      <p className="flex items-start gap-2 rounded-2xl bg-[var(--swift-subtle)] p-4 text-xs text-[var(--swift-muted)]">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{DOCUMENTS_FOOTNOTE}</span>
      </p>
    </div>
  );
}
