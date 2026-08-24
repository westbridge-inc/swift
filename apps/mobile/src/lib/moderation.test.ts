import { describe, expect, it } from 'vitest';
import { buildReportInput, REPORT_REASONS } from './moderation';

describe('moderation report input', () => {
  it('offers every server reason code, including the child-safety escalation', () => {
    expect(REPORT_REASONS.map((reason) => reason.code)).toEqual([
      'SPAM',
      'HARASSMENT',
      'HATE_SPEECH',
      'VIOLENCE',
      'SEXUAL_CONTENT',
      'CSAE',
      'ILLEGAL_GOODS',
      'OTHER',
    ]);
  });

  it('trims optional detail and omits an empty value', () => {
    expect(buildReportInput('CHAT_MESSAGE', 'message-1', 'HARASSMENT', '  repeated threats  ')).toEqual({
      targetType: 'CHAT_MESSAGE',
      targetId: 'message-1',
      reason: 'HARASSMENT',
      detail: 'repeated threats',
    });
    expect(buildReportInput('ITEM', 'item-1', 'SPAM', '   ')).toEqual({
      targetType: 'ITEM',
      targetId: 'item-1',
      reason: 'SPAM',
    });
  });
});

