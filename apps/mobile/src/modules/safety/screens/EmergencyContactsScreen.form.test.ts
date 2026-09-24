import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [phone feedback P3] Safety → Emergency Contacts → "Add an emergency contact"
// on the owner's iPhone: three ~140px boxes centred under centred labels, a
// phone field showing only "+", and a faded button reading "Enter their name
// and full number".
//
// ROOT CAUSE: PopupCard centres its content (`alignItems: 'center'` on the
// card's scroll content — right for the pictogram-and-two-buttons dialogs it
// was built for), so a child with no width of its own shrinks to its
// content. Every other popup form in the app wraps its fields in an
// `alignSelf: 'stretch'` column; this screen rendered its three LabeledInputs
// as direct children of the card. Fixed at the screen, in the app's own
// convention — the kit and the other five popup forms are untouched.
//
// Read as source: the screen pulls in react-native, which Vitest cannot import.
// The rules behind the form are real logic, tested in
// lib/emergencyContactForm.test.ts; this pins that the screen uses them.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./EmergencyContactsScreen.tsx', import.meta.url), 'utf8'));
const CHIP = strip(readFileSync(new URL('../../../kit/dial-code-chip.tsx', import.meta.url), 'utf8'));
const CARD = strip(readFileSync(new URL('../../../kit/card.tsx', import.meta.url), 'utf8'));

const addForm = SCREEN.slice(SCREEN.indexOf('<PopupCard visible={adding}'), SCREEN.indexOf('</PopupCard>', SCREEN.indexOf('<PopupCard visible={adding}')));
const verifyForm = SCREEN.slice(SCREEN.indexOf('<PopupCard visible={verifying != null}'), SCREEN.indexOf('</PopupCard>', SCREEN.indexOf('<PopupCard visible={verifying != null}')));

describe('the add form is full-width with left-aligned labels', () => {
  it('the card still centres its content — the fix is not a kit change that would move every other dialog', () => {
    expect(CARD).toMatch(/contentContainerStyle=\{\{\s*alignItems: 'center',\s*padding: space\['2xl'\],\s*\}\}/);
  });

  it('the whole form — title, copy, three inputs and the button — sits in one stretched column', () => {
    expect(addForm.length).toBeGreaterThan(300);
    const column = addForm.indexOf("<View style={{ alignSelf: 'stretch', gap: space.lg }}>");
    expect(column).toBeGreaterThan(-1);
    // nothing renders as a direct child of the card before the column
    expect(addForm.slice(0, column)).not.toContain('<LabeledInput');
    expect(addForm.slice(0, column)).not.toContain('<PopupTitle');
    expect(addForm.match(/<LabeledInput/g)).toHaveLength(3);
    expect(addForm).toContain('label="Their name"');
    expect(addForm).toContain('label="Their phone"');
    expect(addForm).toContain('label="Relationship (optional)"');
  });

  it('the verify dialog’s code input and button are stretched the same way', () => {
    expect(verifyForm).toContain("<View style={{ alignSelf: 'stretch', gap: space.lg }}>");
    expect(verifyForm).toContain('<CodeInput value={code} onChange={setCode} error={verify.isError} />');
  });

  it('keyboard-aware: the card owns the KeyboardAvoidingView and a tap-through scroll, so the fields and button stay above the keyboard', () => {
    expect(CARD).toMatch(/<KeyboardAvoidingView\s*behavior=\{Platform\.OS === 'ios' \? 'padding' : 'height'\}/);
    expect(CARD).toContain('keyboardShouldPersistTaps="handled"');
  });
});

describe('the phone field is the sign-in phone field: fixed +592, local digits, numeric keypad', () => {
  it('starts as the market calling code in a chip, with an empty local-digits field', () => {
    expect(SCREEN).toContain("const [digits, setDigits] = useState('');");
    expect(SCREEN).not.toContain("useState('+592')");
    expect(addForm).toContain('right={<DialCodeChip countryCode={DEFAULT_COUNTRY.code} dialCode={DEFAULT_COUNTRY.dialCode} countryName={DEFAULT_COUNTRY.name} />}');
    expect(CHIP).toContain('accessibilityLabel={`${countryName} calling code ${dialCode}`}');
    expect(CHIP).toContain('<T variant="label">{flagEmoji(countryCode)}</T>');
  });

  it('takes local digits on the phone keypad, clamped by the shared phone helper, with the market’s example as placeholder', () => {
    expect(addForm).toContain('keyboardType="phone-pad"');
    expect(addForm).toContain('onChangeText={(typed) => setDigits(clampPhone(DEFAULT_COUNTRY.dialCode, typed))}');
    expect(addForm).toContain('placeholder={phoneExample(DEFAULT_COUNTRY.code)}');
    expect(addForm).toContain('accessibilityHint="Enter their number without the country calling code"');
  });

  it('sends the composed E.164 number — never the raw field', () => {
    expect(SCREEN).toMatch(/const form = emergencyContactForm\(\{\s*name,\s*digits,\s*dialCode: DEFAULT_COUNTRY\.dialCode,\s*countryCode: DEFAULT_COUNTRY\.code,/);
    expect(SCREEN).toContain('phoneE164: form.phoneE164,');
    expect(SCREEN).not.toMatch(/phoneE164: phone\.trim\(\)/);
  });
});

describe('the button says what it does; hints live under their fields', () => {
  it('"Send code", enabled only when the form is valid', () => {
    expect(addForm).toContain('label={EMERGENCY_CONTACT_CTA}');
    expect(addForm).toContain('disabled={!form.canSubmit}');
    expect(SCREEN).not.toContain('Enter their name and full number');
    expect(SCREEN).not.toContain("'Send the code'");
    expect(SCREEN).toContain('if (!form.canSubmit) return;');
  });

  it('the validation hints are helper text under the offending field, shown once that field was left', () => {
    expect(addForm).toMatch(/label="Their name"[\s\S]*?onBlur=\{\(\) => setNameTouched\(true\)\}[\s\S]*?error=\{form\.nameHint\}/);
    expect(addForm).toMatch(/label="Their phone"[\s\S]*?onBlur=\{\(\) => setPhoneTouched\(true\)\}[\s\S]*?error=\{form\.phoneHint\}/);
  });

  it('the server’s own refusal (too many contacts, SMS budget, send failure) is shown under the form, not under an unrelated field', () => {
    expect(addForm).not.toMatch(/label="Relationship \(optional\)"[\s\S]*?error=\{addError\}/);
    expect(addForm).toMatch(/\{addError \? \([\s\S]*?<T variant="caption" tone="error" style=\{\{ flex: 1 \}\}>\{addError\}<\/T>/);
    expect(SCREEN).toContain("?? 'Could not save that contact.'");
  });

  it('closing or saving clears the form and its last error, so a reopened sheet never starts red', () => {
    expect(SCREEN).toMatch(/const resetAdd = \(\) => \{[\s\S]*?setDigits\(''\);[\s\S]*?setNameTouched\(false\);[\s\S]*?setPhoneTouched\(false\);[\s\S]*?add\.reset\(\);/);
    expect(addForm).toContain('<PopupCard visible={adding} onClose={resetAdd}>');
    expect(SCREEN).toContain('{ onSuccess: resetAdd }');
  });
});

describe('everything that already worked still does', () => {
  it('the 6-digit confirmation flow, its copy, resend and the honest unverified state', () => {
    expect(SCREEN).toContain('We text them a 6-digit code now. Ask them to read it back to you, so we know the number');
    expect(SCREEN).toContain('Each number is confirmed first: they receive a 6-digit code and read it back to');
    expect(verifyForm).toContain('label="Confirm"');
    expect(verifyForm).toContain('disabled={code.length < 4}');
    expect(SCREEN).toContain("if (!verifying || code.length < 4) return;");
    expect(SCREEN).toContain('label="Text it again"');
    expect(SCREEN).toContain("'Not confirmed — will NOT be alerted'");
    expect(SCREEN).toContain("?? 'That code did not match. Ask them to read it again.'");
  });
});
