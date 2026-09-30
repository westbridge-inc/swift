import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/screens/auth/OtpVerificationScreen.tsx'),
  'utf8',
);
const registerSource = readFileSync(
  join(process.cwd(), 'src/screens/auth/RegisterScreen.tsx'),
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
    expect(source).toContain('testID="otp-resend-wait"');
    expect(source).toContain('accessibilityRole="alert"');
    expect(source).toContain('accessibilityLiveRegion="assertive"');
  });

  it('hands the server-issued signup capability directly to registration and never persists it', () => {
    expect(source).toContain("typeof data.registrationProof === 'string' ? data.registrationProof : ''");
    expect(source).toMatch(/navigation\.navigate\('Register',\s*\{[\s\S]*registrationProof/);
    expect(registerSource).toContain("route.params?.registrationProof ?? ''");
    expect(registerSource).toMatch(/authApi\.register\(\{[\s\S]*registrationProof/);
    expect(registerSource).toContain('const valid = !!registrationProof');
    expect(registerSource).toContain('const mustVerifyAgain = !registrationProof || register.isError');
    expect(registerSource).toContain('testID="register-verify-phone-again"');
    expect(registerSource).toContain("navigation.reset({ index: 0, routes: [{ name: 'PhoneEntry' }] })");
    expect(source + registerSource).not.toMatch(/(?:AsyncStorage|SecureStore|localStorage).*registrationProof/);
  });
});
