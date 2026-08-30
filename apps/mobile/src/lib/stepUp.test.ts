import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fmtWhen, isStepUpDismissed, isStepUpRequired, serverMessage, StepUpDismissed } from './stepUp';

// ---------------------------------------------------------------------------
// [ALG-34] The client half of step-up: recognise the server's answer exactly,
// retry once after a verify, show the server's sentence, invent no time.
// ---------------------------------------------------------------------------

const err = (status: number, code?: string, message?: string) => ({ response: { status, data: { error: { code, message } } } });

describe('recognising STEP_UP_REQUIRED', () => {
  it('is the 403 with that code and nothing else', () => {
    expect(isStepUpRequired(err(403, 'STEP_UP_REQUIRED'))).toBe(true);
    expect(isStepUpRequired(err(403, 'STAFF_FORBIDDEN'))).toBe(false);
    expect(isStepUpRequired(err(401, 'STEP_UP_REQUIRED'))).toBe(false);
    expect(isStepUpRequired(new Error('network'))).toBe(false);
    expect(isStepUpRequired(null)).toBe(false);
  });

  it("the server's sentence wins; the fallback only when it said nothing", () => {
    expect(serverMessage(err(429, 'STEP_UP_LOCKED', 'Too many wrong codes. Try again in 15 minutes.'), 'x')).toBe('Too many wrong codes. Try again in 15 minutes.');
    expect(serverMessage({ response: { data: { message: 'plain' } } }, 'x')).toBe('plain');
    expect(serverMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });

  it('a dismissed sheet is a non-event, distinguishable from a failure', () => {
    expect(isStepUpDismissed(new StepUpDismissed())).toBe(true);
    expect(isStepUpDismissed({ name: 'StepUpDismissed' })).toBe(true);
    expect(isStepUpDismissed(new Error('x'))).toBe(false);
  });

  it('a server moment renders for a person, and garbage renders as nothing — never an invented time', () => {
    expect(fmtWhen('2026-08-31T05:30:00.000Z')).toMatch(/\d/);
    expect(fmtWhen('not a date')).toBeNull();
    expect(fmtWhen(null)).toBeNull();
    expect(fmtWhen(undefined)).toBeNull();
  });
});

describe('the hook retries exactly once, only after a verify', () => {
  const src = readFileSync(join(process.cwd(), 'src/hooks/useStepUp.tsx'), 'utf8');

  it('only STEP_UP_REQUIRED opens the sheet; every other error passes through', () => {
    expect(src).toContain('if (!isStepUpRequired(e)) throw e;');
  });

  it('the retry re-runs the SAME call with the SAME arguments, once, and dismissal rejects with StepUpDismissed', () => {
    const retry = src.slice(src.indexOf('retry: () => {'), src.indexOf('dismiss: () => {'));
    expect(retry).toContain('fn(...args).then(resolve, reject);');
    expect((retry.match(/fn\(\.\.\.args\)/g) ?? []).length).toBe(1);
    const dismiss = src.slice(src.indexOf('dismiss: () => {'));
    expect(dismiss).toContain('reject(new StepUpDismissed());');
    expect(src).toContain('onVerified={() => pendingRef.current?.retry()}');
    expect(src).toContain('onClose={() => pendingRef.current?.dismiss()}');
  });
});

describe('the code sheet', () => {
  const src = readFileSync(join(process.cwd(), 'src/components/StepUpSheet.tsx'), 'utf8');

  it('sends on open, auto-submits at six digits, and never guesses a reason — every error line is the server\'s sentence', () => {
    expect(src).toContain('send.mutate();');
    expect(src).toContain('if (v.length === CODE_LEN) submit(v);');
    expect(src).toContain("serverMessage(send.error,");
    expect(src).toContain("serverMessage(verify.error,");
    expect(src).toContain('authApi.stepUp()');
    expect(src).toContain('authApi.verifyStepUp(c)');
  });

  it('says the one thing that defeats a social-engineered code, and hands control back only on a verified session', () => {
    expect(src).toContain('Swift will never ask you for this code.');
    const onSuccess = src.slice(src.indexOf('mutationFn: (c: string) => authApi.verifyStepUp(c)'));
    expect(onSuccess.slice(0, 200)).toContain('onVerified();');
    expect(src).toContain('accessibilityRole="alert"');
  });
});
