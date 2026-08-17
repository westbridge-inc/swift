import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/screens/auth/OtpVerificationScreen.tsx'),
  'utf8',
);

describe('OTP verification accessibility and automation contract', () => {
  it('exposes a stable, labelled code-entry target without making visual cells separate controls', () => {
    expect(source).toContain('testID="otp-code-entry"');
    expect(source).toContain('accessibilityRole="button"');
    expect(source).toContain('accessibilityLabel="Enter 6-digit verification code"');
    expect(source).toContain('accessibilityValue={{ text: `${code.length} of ${CODE_LEN} digits entered` }}');
    expect(source).toContain('testID="otp-code-input"');
    expect(source).toContain('textContentType="oneTimeCode"');
    expect(source).toContain('autoComplete="one-time-code"');
    expect(source).toContain('accessible={false}');
  });

  it('pins resend, verify, and error feedback semantics for screen readers and Maestro', () => {
    expect(source).toContain('testID="otp-resend"');
    expect(source).toContain('accessibilityLabel="Resend verification code"');
    expect(source).toContain('accessibilityState={{ disabled: resend.isPending, busy: resend.isPending }}');
    expect(source).toContain('testID="otp-verify"');
    expect(source).toContain('accessibilityRole="alert"');
    expect(source).toContain('accessibilityLiveRegion="assertive"');
  });
});
