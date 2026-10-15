import { apiFetch } from './auth';

/**
 * [R19 · Child Safety Standards · legal research E10] The website's report surface: the reasons a person can pick,
 * in the server's codes (POST /reports), Child safety (CSAE) among them. The server pages operations at once for a
 * CSAE report. Word for word the phone's list (apps/mobile lib/reportReasons.ts); report-reasons.test.ts holds them.
 */
export type ReportReason = 'SPAM' | 'HARASSMENT' | 'HATE_SPEECH' | 'VIOLENCE' | 'SEXUAL_CONTENT' | 'CSAE' | 'ILLEGAL_GOODS' | 'OTHER';

export const CHILD_SAFETY_REASON: { key: ReportReason; label: string } = { key: 'CSAE', label: 'Child safety (CSAE)' };

/** Reporting a store. */
export const STORE_REPORT_REASONS: Array<{ key: ReportReason; label: string }> = [
  { key: 'SPAM', label: 'Misleading or spam' },
  { key: 'ILLEGAL_GOODS', label: 'Selling something it shouldn’t' },
  { key: 'HATE_SPEECH', label: 'Hateful content' },
  { key: 'SEXUAL_CONTENT', label: 'Sexual content' },
  CHILD_SAFETY_REASON,
  { key: 'OTHER', label: 'Something else' },
];

export function reportContent(input: { targetType: 'VENDOR' | 'RATING' | 'USER' | 'ITEM'; targetId: string; reason: ReportReason }) {
  return apiFetch('/api/v1/reports', { method: 'POST', body: JSON.stringify(input) }, { redirectOnExpired: false });
}

/** What the person is told once a report is filed. */
export const reportThanks = (reason: ReportReason) => (reason === 'CSAE'
  ? 'Thank you. Child-safety reports go to a person on our team straight away.'
  : 'Thanks — our team will look. Reports are reviewed by a person.');
