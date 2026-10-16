import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_REPORT_REASONS, CHILD_SAFETY_REASON, STORE_REPORT_REASONS } from './reportReasons';

// ---------------------------------------------------------------------------
// [Brief item 3] The published Child Safety Standards tell people to "use the Report action on a review, chat
// message, profile or listing and select the Child safety (CSAE) reason". The phone app's chat report had no
// reason to pick (every chat report was filed as HARASSMENT) and the store report had no child-safety
// reason. Both now offer it (phone build 12); the server pages operations for it.
// ---------------------------------------------------------------------------

const API = (...p: string[]) => readFileSync(join(process.cwd(), '..', 'api', 'src', ...p), 'utf8');
const SRC = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8');

describe('Child safety (CSAE) can be picked wherever the app files a report', () => {
  it('the label is the reason the Child Safety Standards name, and the code is the server’s', () => {
    expect(CHILD_SAFETY_REASON).toEqual({ key: 'CSAE', label: 'Child safety (CSAE)' });
    const serverReasons = /reason: z\.enum\(\[([^\]]+)\]\)/.exec(API('modules', 'moderation', 'moderation.routes.ts'))![1]!.match(/'([A-Z_]+)'/g)!.map((s) => s.slice(1, -1));
    for (const r of [...CHAT_REPORT_REASONS, ...STORE_REPORT_REASONS]) expect(serverReasons).toContain(r.key);
  });

  it('the chat report and the store report both offer it', () => {
    expect(CHAT_REPORT_REASONS).toContainEqual(CHILD_SAFETY_REASON);
    expect(STORE_REPORT_REASONS).toContainEqual(CHILD_SAFETY_REASON);
  });

  it('the conversation screen asks for a reason and files the one picked — never a fixed HARASSMENT', () => {
    const screen = SRC('modules', 'chat', 'screens', 'ConversationScreen.tsx');
    expect(screen).not.toMatch(/reason: 'HARASSMENT'/);
    expect(screen).toMatch(/CHAT_REPORT_REASONS\.map\(/);
    expect(screen).toMatch(/reason: reason\.key/);
  });

  it('the store screen files its reasons from the shared list', () => {
    const screen = SRC('modules', 'shop', 'screens', 'RestaurantScreen.tsx');
    expect(screen).toMatch(/STORE_REPORT_REASONS\.map\(/);
  });

  it('the review sheet offers Child safety too, filed through the general report (which pages operations)', () => {
    const screen = SRC('modules', 'shop', 'screens', 'VendorReviewsScreen.tsx');
    expect(screen).toMatch(/CHILD_SAFETY_REASON\.label/);
    expect(screen).toMatch(/targetType: 'RATING'[^}]*reason: 'CSAE'/);
  });
});
