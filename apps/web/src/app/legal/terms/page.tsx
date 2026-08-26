import { LegalDocument, legalMetadata } from '@/components/legal-document';
import { TERMS_BODY } from '@/legal/generated';

export const metadata = legalMetadata(
  'Terms of Service',
  'The terms governing use of Swift — an independent marketplace where businesses and movers keep 100% of what they earn.',
  '/legal/terms',
);

export default function TermsPage() {
  return <LegalDocument title="Terms of Service" html={TERMS_BODY} />;
}
