export type ModerationTargetType =
  | 'RATING'
  | 'RATING_RESPONSE'
  | 'CHAT_MESSAGE'
  | 'USER'
  | 'VENDOR'
  | 'ITEM'
  | 'CATEGORY'
  | 'PROMO_CODE'
  | 'SERVICE_PROVIDER'
  | 'SERVICE_JOB'
  | 'ORDER'
  | 'AD_CREATIVE';

export type ReportReason =
  | 'SPAM'
  | 'HARASSMENT'
  | 'HATE_SPEECH'
  | 'VIOLENCE'
  | 'SEXUAL_CONTENT'
  | 'CSAE'
  | 'ILLEGAL_GOODS'
  | 'OTHER';

export const REPORT_REASONS: ReadonlyArray<{ code: ReportReason; label: string }> = [
  { code: 'SPAM', label: 'Spam or scam' },
  { code: 'HARASSMENT', label: 'Harassment or bullying' },
  { code: 'HATE_SPEECH', label: 'Hate speech' },
  { code: 'VIOLENCE', label: 'Violence or threats' },
  { code: 'SEXUAL_CONTENT', label: 'Sexual content' },
  { code: 'CSAE', label: 'Child sexual abuse or exploitation' },
  { code: 'ILLEGAL_GOODS', label: 'Illegal goods or activity' },
  { code: 'OTHER', label: 'Something else' },
] as const;

export interface ReportInput {
  targetType: ModerationTargetType;
  targetId: string;
  reason: ReportReason;
  detail?: string;
}

/** Keep optional report context truly optional. The API trims too, but doing
 * this at the seam prevents sending whitespace as meaningful audit text. */
export function buildReportInput(
  targetType: ModerationTargetType,
  targetId: string,
  reason: ReportReason,
  detail: string,
): ReportInput {
  const cleanDetail = detail.trim();
  return {
    targetType,
    targetId,
    reason,
    ...(cleanDetail ? { detail: cleanDetail } : {}),
  };
}
