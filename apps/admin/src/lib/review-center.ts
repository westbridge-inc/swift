import { fetchVerificationQueue } from './api';

export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ReviewLane = 'operator' | 'customer' | 'all';
export interface ReviewDocument {
  id: string; userId: string; docType: string; role: string; status: ReviewStatus;
  createdAt?: string; consentAt?: string | null; privacyNoticeVersion?: string | null;
  expiresAt?: string | null;
  user?: {
    id: string; firstName?: string; lastName?: string; phone?: string; countryCode?: string;
    driver?: { licensePlate?: string; vehicleMake?: string; vehicleModel?: string; vehicleType?: string } | null;
  };
}
export interface Applicant { id: string; name: string; phone: string; documents: ReviewDocument[]; oldest: number }
export const docLabel = (type: string) => type.replaceAll('_', ' ');
export const applicantId = (doc: ReviewDocument) => doc.userId || doc.user?.id || doc.id;
export const maskedPhone = (phone?: string) => phone ? `••• ••• ${phone.slice(-4)}` : 'No phone on file';

/** Follow the server's page metadata. No partial success if a later page fails. */
export async function loadReviewQueue(status: ReviewStatus, lane: ReviewLane): Promise<ReviewDocument[]> {
  const docs = new Map<string, ReviewDocument>();
  for (let page = 1; ; page++) {
    const result = await fetchVerificationQueue(status, lane, page);
    if (!Array.isArray(result.data)) throw new Error('The queue returned no document list.');
    for (const doc of result.data as ReviewDocument[]) docs.set(doc.id, doc);
    if (!result.meta?.hasNext) break;
    // Fail closed on malformed/non-progressing pagination rather than looping forever.
    if (!result.data.length || page >= 1000) throw new Error('The queue could not be loaded completely. Narrow the lane and retry.');
  }
  return [...docs.values()];
}
export function groupApplicants(docs: ReviewDocument[]): Applicant[] {
  const groups = new Map<string, Applicant>();
  for (const doc of docs) {
    const id = applicantId(doc);
    const created = Date.parse(doc.createdAt ?? '') || 0;
    const group = groups.get(id) ?? {
      id, name: [doc.user?.firstName, doc.user?.lastName].filter(Boolean).join(' ') || 'Unnamed applicant',
      phone: doc.user?.phone ?? '', documents: [], oldest: created,
    };
    group.documents.push(doc);
    group.oldest = Math.min(group.oldest, created);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.oldest - b.oldest || a.id.localeCompare(b.id));
}
export function waitingSince(timestamp: number, now: number): string {
  if (!timestamp) return 'Submission time unavailable';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `Waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Waiting ${hours}h` : `Waiting ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
