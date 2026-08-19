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

  it('makes both country-changing affordances explicit buttons', () => {
    expect(source).toContain('testID="auth-country-picker"');
    expect(source).toContain('accessibilityLabel={`Change country calling code. Current code ${dialCode ?? \'+592\'}`}');
    expect(source).toContain('accessibilityLabel="Change country"');
    expect(source.match(/accessibilityRole="button"/g) ?? []).toHaveLength(2);
  });
});
