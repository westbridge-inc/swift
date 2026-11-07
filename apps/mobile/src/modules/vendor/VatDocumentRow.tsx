import { useState } from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { PillButton, T } from '../../kit';
import { useStoreVat } from '../../hooks/storeVat';
import { useVendorPreview } from '../../stores/vendorPreview';
import { VAT_DOCUMENT_ROW } from '../../lib/storeVat';
import { StoreVatSection } from './StoreVatSection';

/** The row's status word, from the store's VAT (GET /vendor/vat). Never says "approved" before a person approved it. */
export function vatDocumentStatusWord(status: string, certificateStatus: string | null | undefined): string {
  switch (status) {
    case 'APPROVED': return 'Approved';
    case 'PENDING': return certificateStatus === 'PENDING' ? 'In review' : 'Not submitted';
    case 'REJECTED': return 'Not approved';
    case 'REVOKED': return 'Withdrawn';
    default: return 'Not submitted';
  }
}

/**
 * [VAT-DOCS · owner 30 Oct 2026] The optional "VAT certificate (only if VAT-registered)" row in a store owner's Documents
 * list. It opens the SAME VAT flow as the Account screen (StoreVatSection): the VAT number, how the prices relate to VAT
 * and the certificate, sent together for a person at Swift to check. Never required to go live (it is not on the
 * store's checklist). Hidden while Swift's VAT switch is off, unless the store already has a VAT record (as the section).
 */
/** `inline` false: the screen already shows the VAT section (the Account screen), so the row points to it instead of
 *  opening a second copy. */
export function VatDocumentRow({ withHeading, inline = true }: { withHeading: boolean; inline?: boolean }) {
  // A sample preview has no VAT (as the Account screen's VAT section).
  const samplePreview = useVendorPreview((st) => st.previewType) != null;
  const vat = useStoreVat(!samplePreview);
  const [open, setOpen] = useState(false);
  const v = vat.data;
  if (samplePreview || !v || (!v.available && v.status === 'NONE')) return null;
  return (
    <View style={{ marginTop: withHeading ? space.md : space.sm }} testID="vat-document-row">
      {withHeading ? (
        <>
          <T variant="heading" style={{ marginBottom: space.xs }}>Optional</T>
          <T variant="label" tone="muted" style={{ marginBottom: space.sm }}>
            You can add these any time. You do not need them to go live.
          </T>
        </>
      ) : null}
      <View style={{ paddingVertical: space.sm, gap: space.xs }}>
        <T variant="label" weight="bold">{VAT_DOCUMENT_ROW.title}</T>
        <T variant="caption" tone="muted">{VAT_DOCUMENT_ROW.body}</T>
        <T variant="caption" weight="semibold">{vatDocumentStatusWord(v.status, v.certificate?.status)}</T>
        {inline ? (
          <PillButton
            label={open ? 'Close' : v.status === 'NONE' ? 'Add the VAT certificate' : 'Open VAT'}
            variant="soft"
            size="sm"
            testID="vat-document-row-open"
            onPress={() => setOpen((o) => !o)}
          />
        ) : (
          <T variant="caption" tone="muted">Add it under VAT, below on this screen.</T>
        )}
      </View>
      {inline && open ? <StoreVatSection /> : null}
    </View>
  );
}
