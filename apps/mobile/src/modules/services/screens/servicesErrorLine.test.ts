import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { errorMessage } from '../../../lib/apiError';

// [NO-DEAD-ENDS] A failed service request, schedule or rating read
// `response.data.message`, a field the API never sends (its refusals are
// `{ error: { code, message } }`), so the line under the form stayed blank and
// only a passing toast said anything. They read the shared helper now.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('service screens show the API’s own refusal under the form', () => {
  it('no service screen reads the field the API never sends', () => {
    expect(read('./ServicesScreen.tsx') + read('./ServiceJobsScreen.tsx')).not.toMatch(/response\?\.data\?\.message/);
  });
  it('request, schedule and rate each read the refusal through errorMessage, with a plain fallback', () => {
    expect(read('./ServicesScreen.tsx')).toContain('errorMessage(requestJob.error, ');
    const jobs = read('./ServiceJobsScreen.tsx');
    expect(jobs).toContain('errorMessage(schedule.error, ');
    expect(jobs).toContain('errorMessage(rate.error, ');
  });
  it('errorMessage reads the API envelope', () => {
    const refusal = { response: { status: 409, data: { success: false, error: { code: 'SLOT_TAKEN', message: 'That time was just booked. Pick another.' } } } };
    expect(errorMessage(refusal, 'fallback')).toBe('That time was just booked. Pick another.');
    expect(errorMessage({ response: { data: { message: 'legacy shape' } } }, 'fallback')).toBe('fallback');
  });
});

describe('[NO-DEAD-ENDS] a failed list or chat says it failed, and offers the retry right there', () => {
  it('the provider list failure has its own Try again, and is not called empty', () => {
    const screen = read('./ServicesScreen.tsx');
    expect(screen).toMatch(/title="Couldn’t load providers"[\s\S]{0,200}actionLabel="Try again"[\s\S]{0,80}onAction=\{\(\) => \{ void refetchProviders\(\); \}\}/);
    expect(screen).toContain('This is not an empty list.');
  });
  it('a chat that failed to open names the failure instead of "wait for a rider"', () => {
    const chat = readFileSync(new URL('../../chat/screens/ConversationScreen.tsx', import.meta.url), 'utf8');
    expect(chat).toMatch(/room\.isError\s*\?\s*errorMessage\(room\.error, 'Couldn’t open this chat\. Check your connection and try again\.'\)/);
  });
});
