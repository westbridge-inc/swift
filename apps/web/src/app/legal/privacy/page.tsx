import { LegalDocument, legalMetadata } from '@/components/legal-document';
import { PRIVACY_BODY } from '@/legal/generated';

export const metadata = legalMetadata(
  'Privacy Policy',
  'What Swift collects, why, who it is shared with, and your rights under Guyana’s Data Protection Act 2023.',
  '/legal/privacy',
);

export default function PrivacyPage() {
  return <LegalDocument title="Privacy Policy" html={PRIVACY_BODY} />;
}
