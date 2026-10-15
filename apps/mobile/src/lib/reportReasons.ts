/**
 * [Brief item 3 · Child Safety Standards: "use the Report action on a review, chat message, profile or listing
 * and select the Child safety (CSAE) reason"] The reasons a person can pick when reporting, in the server's
 * codes (POST /reports). Child safety (CSAE) is offered everywhere a report is made; the server pages
 * operations at once for it. The label is the one the published standards name.
 */
export type ReportReason = 'SPAM' | 'HARASSMENT' | 'HATE_SPEECH' | 'VIOLENCE' | 'SEXUAL_CONTENT' | 'CSAE' | 'ILLEGAL_GOODS' | 'OTHER';

export const CHILD_SAFETY_REASON: { key: ReportReason; label: string } = { key: 'CSAE', label: 'Child safety (CSAE)' };

/** Reporting a conversation (its latest message from the other person, or the person). */
export const CHAT_REPORT_REASONS: Array<{ key: ReportReason; label: string }> = [
  { key: 'HARASSMENT', label: 'Harassment or threats' },
  { key: 'SEXUAL_CONTENT', label: 'Sexual content' },
  CHILD_SAFETY_REASON,
  { key: 'HATE_SPEECH', label: 'Hateful content' },
  { key: 'SPAM', label: 'Spam or a scam' },
  { key: 'OTHER', label: 'Something else' },
];

/** Reporting a store. */
export const STORE_REPORT_REASONS: Array<{ key: ReportReason; label: string }> = [
  { key: 'SPAM', label: 'Misleading or spam' },
  { key: 'ILLEGAL_GOODS', label: 'Selling something it shouldn’t' },
  { key: 'HATE_SPEECH', label: 'Hateful content' },
  { key: 'SEXUAL_CONTENT', label: 'Sexual content' },
  CHILD_SAFETY_REASON,
  { key: 'OTHER', label: 'Something else' },
];
