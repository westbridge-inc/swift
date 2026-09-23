import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/screens/auth/PhoneEntryScreen.tsx'),
  'utf8',
);

describe('phone authentication entry contract', () => {
  it('exposes stable, labelled phone and submit controls for assistive tech and E2E', () => {
    expect(source).toContain('testID="auth-phone-input"');
    expect(source).toContain('accessibilityLabel="Phone number"');
    expect(source).toContain('accessibilityHint="Enter your phone number without the country calling code"');
    expect(source).toContain('testID="auth-send-code"');
    expect(source).toContain('testID="auth-browse-guest"');
  });

  it('pins signup to Guyana without presenting a misleading country picker', () => {
    expect(source).toContain('accessibilityLabel="Guyana calling code +592"');
    expect(source).toContain('+592');
    expect(source).not.toContain('auth-country-picker');
    expect(source).not.toContain('Wrong country?');
    expect(source).not.toContain("navigate('CountryPicker')");
  });

  it('describes the mover path as becoming a Swift driver, not booking a taxi', () => {
    expect(source).toContain("const earnerLabel = intent === 'vendor' ? 'a business' : 'a Swift driver'");
    expect(source).not.toContain("moverPreset === 'taxi'");
  });
});
