import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { BrandCheckbox, EmptyState, Spinner, T } from '../../kit';
import { DOCUMENT_CONSENT_TEXT } from '../../lib/uploadConsentCopy';
import { DocumentUploadCard } from './DocumentUploadCard';
import { OwnNameCard } from './OwnNameCard';
import { FoodHandlersCard } from './FoodHandlersCard';
import { FOOD_HANDLERS_DOC } from './foodHandlers';
import { ownNameApplies } from '../../lib/ownNameCopy';
import { isTaxiChecklist, taxiDocumentHint, TAXI_TWO_LICENCES } from './taxiDocumentCopy';
import { DOCUMENT_REVIEW_PROMISE, emptyChecklistCopy, optionalDocHint, optionalDocTypes } from './documentChecklistPresentation';
import { SENSITIVE_DOC_TYPES, documentConsentGivenLine, documentConsentOnRecord, policeClearanceWordsFrom } from './documentConsentRecord';
import type { UploadConsentVia } from '../../services/api';

/** The progress track. `h-1.5` was 6px via Tailwind's default scale — the
 *  theme maps no numeric spacing, so it was never a token. Named here so the
 *  bar and its fill cannot drift apart. */
const TRACK_HEIGHT = 6;
/** [ROLE-DOCS] The signed "I trade under my own name" declaration (the server's OWN_NAME_DOC_TYPE). */
const OWN_NAME_DOC = 'own_name_declaration';

/**
 * Renders GET /verification/status?role= as the "Required steps" checklist.
 * Honest about every state — a failed/loading request is NOT silently shown as
 * "no documents required" (which previously masked a 500 behind an "upload your
 * documents" banner). Pass the query's `isLoading`/`isError`/`onRetry` so the
 * screen can't contradict itself.
 */
export function DocumentChecklist({
  role,
  status,
  isLoading,
  isError,
  onRetry,
  storeName,
}: {
  role: string;
  status: any;
  /** [ROLE-DOCS · per store] the selected store's name, for the own-name card */
  storeName?: string | null;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}) {
  // [R17] uploads wait for the consent tick; a hook, so before the early returns. [DOC-CONSENT · owner 25 Oct 2026]
  // The tick is the person's own: the one they give on this visit (`choice`), else their grant the consent ledger
  // already holds (GET /verification/status `documentConsent`). It used to live only on the screen, so every new
  // visit emptied a tick the server had recorded. With no record and no tick on this visit, it starts empty.
  const [choice, setChoice] = useState<boolean | null>(null);
  const record = documentConsentOnRecord(status);
  const consented = choice ?? record.given;
  const toggleConsent = () => setChoice((c) => !(c ?? record.given));
  // Shown only while the box stands on the record, so the person sees the tick is theirs and when they gave it.
  const recordLine = choice === null && record.given ? documentConsentGivenLine(record.givenAt) : null;
  // [DPA s.9(1)(a) · research D1] A police clearance is not opened by the record alone: its card asks again.
  const askConsentFirst = (docType: string) => choice !== true && SENSITIVE_DOC_TYPES.has(docType);
  // [DOC-CONSENT S4] Each upload tells the ledger how the tick was given: ticked on this visit, or shown from the record
  // (a card that asks again records its prompt instead).
  const consentVia: UploadConsentVia = choice === true ? 'checkbox' : 'record';
  // [POLICE-CLEARANCE CONSENT] A police clearance has its OWN tick, in the API's words (none from an older API).
  const policeWords = policeClearanceWordsFrom(status);
  const policeConsentFor = (docType: string) => (docType === 'police_clearance' ? policeWords : null);
  if (isLoading) {
    return (
      <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: space['2xl'] }}>
        <Spinner />
      </View>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon="alert-circle"
        title="Couldn’t load your verification steps"
        body="We couldn’t reach the server. Check your connection and try again."
        actionLabel={onRetry ? 'Retry' : undefined}
        onAction={onRetry}
      />
    );
  }

  const checklist: string[] = status?.checklist ?? [];
  // [VERIFY-DOCS] Documents the person MAY add — shown after the required ones, never counted.
  const optional = optionalDocTypes(status);
  const documents: any[] = status?.documents ?? [];

  const latestDoc = (docType: string) => {
    const docs = documents
      .filter((d) => d.docType === docType)
      .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
    // Precedence: an in-flight renewal shows as pending; else the current
    // approved document (with its expiry); else the newest row (expired/
    // rejected) which re-opens the upload.
    return (
      docs.find((d) => d.status === 'PENDING')
      ?? docs.find((d) => d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > new Date()))
      ?? docs[0]
    );
  };

  const nextDoc = checklist.find((dt) => latestDoc(dt)?.status !== 'APPROVED');

  if (checklist.length === 0) {
    const copy = emptyChecklistCopy(status ?? {});
    return (
      <EmptyState
        icon="shield"
        title={copy.title}
        body={copy.body}
      />
    );
  }

  const approvedCount = checklist.filter((dt) => latestDoc(dt)?.status === 'APPROVED').length;
  const allSubmitted = checklist.every((dt) => ['APPROVED', 'PENDING'].includes(latestDoc(dt)?.status));

  return (
    <View>
      <T variant="heading" style={{ marginBottom: space.xs }}>
        Required steps
      </T>
      <T variant="label" tone="muted" style={{ marginBottom: space.sm }}>
        {/* [Owner 15 Oct 2026] no promise faster than the support hours allow */}
        Upload these to activate your account. We review them Monday to Saturday, 8:00–16:00 Guyana time.
      </T>
      {/* [R17 · legal research D2/B1] a tick before any upload; the API records it in the consent ledger.
          [DOC-CONSENT] ticked only by the person: on this visit, or their own grant on record. */}
      <Pressable
        onPress={toggleConsent}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consented }}
        accessibilityLabel={DOCUMENT_CONSENT_TEXT}
        accessibilityHint={recordLine ?? undefined}
        testID="document-consent-tick"
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md }}
      >
        <BrandCheckbox checked={consented} onToggle={toggleConsent} />
        <View style={{ flex: 1 }}>
          <T variant="label" tone="muted">{DOCUMENT_CONSENT_TEXT}</T>
          {recordLine ? (
            <T variant="micro" tone="muted" style={{ marginTop: 2 }}>
              {recordLine}
            </T>
          ) : null}
        </View>
      </Pressable>
      {isTaxiChecklist(checklist) ? (
        <T variant="label" style={{ marginBottom: space.sm }}>
          {TAXI_TWO_LICENCES}
        </T>
      ) : null}
      {/* [Legal research G4, in-app ¶17] What happens to the documents, truly: a person checks them, and the
          daily expiry sweep re-checks the dates. */}
      <T variant="micro" tone="muted" style={{ marginBottom: space.sm }}>
        {DOCUMENT_REVIEW_PROMISE}
      </T>
      {/* Progress — how far through the door they are */}
      <View style={{ marginBottom: space.md }}>
        <View style={{ marginBottom: space.xs, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T variant="micro" weight="semibold" tone="muted">
            {approvedCount} of {checklist.length} approved
          </T>
          {allSubmitted && approvedCount < checklist.length ? (
            <T variant="micro" weight="semibold" style={{ color: color.brand[500] }}>
              All submitted — in review
            </T>
          ) : null}
        </View>
        {/* The track's ground is `sunken`, which the palette defines for exactly
            this ("grouped sections / tracks"). It was `subtle` — which the same
            file defines as "paper — the app background". A track painted in the
            page's own colour is invisible, and at "0 of 5 approved" the fill is
            0% wide, so a new mover saw a caption with NOTHING under it and no
            sense that progress was even being kept. The bar only existed once
            you had already made progress. */}
        <View style={{ height: TRACK_HEIGHT, overflow: 'hidden', borderRadius: radius.full, backgroundColor: color.surface.sunken }}>
          <View
            style={{
              height: TRACK_HEIGHT,
              borderRadius: radius.full,
              width: `${Math.round((approvedCount / checklist.length) * 100)}%`,
              backgroundColor: color.success,
            }}
          />
        </View>
      </View>
      {checklist.map((docType) => {
        // [FOOD-PERMIT · owner 24 Oct 2026] the food handlers step is a tick (the server's words), never an upload
        if (docType === FOOD_HANDLERS_DOC) return <FoodHandlersCard key={docType} role={role} status={status} />;
        const doc = latestDoc(docType);
        // [ROLE-DOCS · owner 21 Oct 2026] the own-name declaration is signed in the app, never uploaded
        if (docType === OWN_NAME_DOC) {
          return !doc || doc.status === 'REJECTED' ? (
            <View key={docType}>
              {doc ? <T variant="caption" tone="error">{doc.reviewNote ?? 'Your own-name declaration was not accepted.'}</T> : null}
              <OwnNameCard role={role} mode="sign" storeName={storeName} />
            </View>
          ) : (
            <View key={docType} style={{ paddingVertical: space.sm }}>
              <T variant="label" weight="bold">I trade under my own name</T>
              <T variant="caption" tone="muted">{doc.status === 'APPROVED' ? 'Checked by a person on our team.' : 'Signed — a person on our team is checking it against your ID.'}</T>
            </View>
          );
        }
        return (
          <DocumentUploadCard
            consented={consented}
            askConsentFirst={askConsentFirst(docType)}
            consentVia={consentVia}
            policeConsent={policeConsentFor(docType)}
            key={docType}
            role={role}
            docType={docType}
            status={doc?.status}
            expiresAt={doc?.status === 'APPROVED' ? doc?.expiresAt : null}
            submittedAt={doc?.createdAt ?? null}
            reviewNote={doc?.reviewNote ?? null}
            replaced={doc?.replaced === true}
            isNext={docType === nextDoc}
            hint={taxiDocumentHint(docType, checklist)}
          />
        );
      })}
      {ownNameApplies(role) && checklist.includes(OWN_NAME_DOC) ? <OwnNameCard role={role} mode="drop" /> : null}
      {ownNameApplies(role) && checklist.includes('business_registration') && latestDoc('business_registration')?.status !== 'APPROVED'
        ? <OwnNameCard role={role} mode="offer" storeName={storeName} /> : null}
      {optional.length > 0 ? (
        <View style={{ marginTop: space.md }}>
          <T variant="heading" style={{ marginBottom: space.xs }}>
            Optional
          </T>
          <T variant="label" tone="muted" style={{ marginBottom: space.sm }}>
            You can add these any time. You do not need them to go live.
          </T>
          {optional.map((docType) => {
            const doc = latestDoc(docType);
            return (
              <DocumentUploadCard
                consented={consented}
                askConsentFirst={askConsentFirst(docType)}
                consentVia={consentVia}
                policeConsent={policeConsentFor(docType)}
                key={docType}
                role={role}
                docType={docType}
                status={doc?.status}
                expiresAt={doc?.status === 'APPROVED' ? doc?.expiresAt : null}
                submittedAt={doc?.createdAt ?? null}
                reviewNote={doc?.reviewNote ?? null}
                replaced={doc?.replaced === true}
                optionalHint={optionalDocHint(docType)}
              />
            );
          })}
        </View>
      ) : null}
      <View style={{ marginTop: space.sm, flexDirection: 'row', alignItems: 'flex-start', borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.md }}>
        <MaterialCommunityIcons name="shield-check-outline" size={16} color={color.text.muted} style={{ marginTop: 1 }} />
        <T variant="micro" tone="muted" style={{ marginLeft: space.sm, flex: 1 }}>
          We confirm your documents are genuine and that they&apos;re yours, and re‑check expiry every day — we&apos;ll
          remind you before anything lapses so you stay verified.
        </T>
      </View>
    </View>
  );
}
