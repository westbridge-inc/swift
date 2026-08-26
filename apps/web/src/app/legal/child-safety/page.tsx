import { LegalDocument, legalMetadata } from '@/components/legal-document';
import { CHILD_SAFETY_BODY } from '@/legal/generated';

/**
 * [STORE-003] Google Play requires any app carrying user-generated content to
 * publish its child-safety standards at a public URL, provide an in-app CSAE
 * report path, and name a point of contact. Swift carries UGC in ratings, chat,
 * profiles and listings, so this is a submission requirement, not an optional
 * page — the Play Console asks for this exact URL in the CSAE declaration.
 *
 * It existed only on the API host, unlinked from anywhere, which meant the one
 * URL a reviewer is given would 404 during any API outage. Same failure the
 * privacy and terms pages had; this one was missed because CHILD_SAFETY was the
 * only legal constant the API never exported.
 */
export const metadata = legalMetadata(
  'Child Safety Standards',
  'Swift has zero tolerance for child sexual abuse and exploitation. How to report it, how we respond, and who to contact.',
  '/legal/child-safety',
);

export default function ChildSafetyPage() {
  return <LegalDocument title="Child Safety Standards" html={CHILD_SAFETY_BODY} />;
}
