import { describe, it, expect } from 'vitest';
import { emergencyContactCodeText, EMERGENCY_CONTACT_NAME_MAX } from '../modules/safety/emergency-contact.service';
import { gsm7Name, gsm7Parts, isGsm7, GSM7_PART } from '../utils/sms-text';

// [R20 · research B10 · DPA s.21(3)(b)] The emergency contact never gave Swift
// their number — the owner did. The first text they receive must therefore say
// who holds the number (Swift, Westbridge Inc.), the one purpose (the owner's
// safety alerts) and how to have it removed. The research fixed the words.
//
// It must also arrive: the text stays in the GSM alphabet (one em dash or emoji
// re-encodes the whole message at 70 characters a part) and at most two parts,
// whatever the owner typed as a first name.

const RESEARCH_TEXT = (owner: string, code: string) =>
  `${owner} added you as their emergency contact on Swift (Westbridge Inc.). We use your number only for their safety alerts. Code ${code}. Not expected? Ignore this; to remove your number: privacy@swiftgy.com.`;

describe('[R20] emergency-contact confirmation text', () => {
  it('is the research B10 text, word for word', () => {
    expect(emergencyContactCodeText('Alea', '123456')).toBe(RESEARCH_TEXT('Alea', '123456'));
  });

  it('names the controller, the single purpose and the removal route', () => {
    const text = emergencyContactCodeText('Alea', '654321');
    expect(text).toContain('Swift (Westbridge Inc.)');
    expect(text).toContain('only for their safety alerts');
    expect(text).toContain('privacy@swiftgy.com');
    expect(text).toContain('Code 654321.');
  });

  it('a missing or unusable name falls back to "A Swift user"', () => {
    expect(emergencyContactCodeText(null, '111111')).toBe(RESEARCH_TEXT('A Swift user', '111111'));
    expect(emergencyContactCodeText('   ', '111111')).toBe(RESEARCH_TEXT('A Swift user', '111111'));
    expect(emergencyContactCodeText('😀🚑', '111111')).toBe(RESEARCH_TEXT('A Swift user', '111111'));
  });

  it('stays in the GSM alphabet and within two parts for any name the profile accepts (max 50)', () => {
    const names = [
      'Alea',
      'Ānanda Persaud', // ā is not GSM: falls back to a
      'Zoë-Marie O’Neil', // curly apostrophe is not GSM: dropped
      'Ravi 😀',
      'Mohanie​Devi', // zero-width space dropped
      'X'.repeat(50),
      'Ä'.repeat(50),
      '{[|]}'.repeat(10), // extended characters cost two septets each
    ];
    for (const name of names) {
      const text = emergencyContactCodeText(name, '999999');
      expect(isGsm7(text), name).toBe(true);
      expect(gsm7Parts(text), name).toBeLessThanOrEqual(2);
    }
  });

  it('the owner name is cleaned and capped', () => {
    expect(gsm7Name('Ānanda', EMERGENCY_CONTACT_NAME_MAX)).toBe('Ananda');
    expect(gsm7Name('Zoë', EMERGENCY_CONTACT_NAME_MAX)).toBe('Zoe'); // ë is not GSM: base letter e
    expect(gsm7Name('José', EMERGENCY_CONTACT_NAME_MAX)).toBe('José'); // é is GSM: kept
    expect(gsm7Name('Zoë-Marie O’Neil', EMERGENCY_CONTACT_NAME_MAX)).toBe('Zoe-Marie ONeil');
    expect(gsm7Name('  Ravi   Singh 😀 ', EMERGENCY_CONTACT_NAME_MAX)).toBe('Ravi Singh');
    expect(gsm7Name('X'.repeat(60), EMERGENCY_CONTACT_NAME_MAX)).toHaveLength(EMERGENCY_CONTACT_NAME_MAX);
  });
});

describe('sms-text helpers', () => {
  it('counts parts: 160 in one, 153 per part beyond', () => {
    expect(gsm7Parts('a'.repeat(160))).toBe(1);
    expect(gsm7Parts('a'.repeat(161))).toBe(2);
    expect(gsm7Parts('a'.repeat(GSM7_PART * 2))).toBe(2);
    expect(gsm7Parts('a'.repeat(GSM7_PART * 2 + 1))).toBe(3);
    expect(gsm7Parts('€'.repeat(80))).toBe(1); // extended: two septets each
    expect(gsm7Parts('€'.repeat(81))).toBe(2);
  });

  it('a non-GSM character makes the text non-GSM', () => {
    expect(isGsm7('Swift — hello')).toBe(false);
    expect(isGsm7('Swift - hello')).toBe(true);
    expect(gsm7Parts('Swift — hello')).toBe(Number.POSITIVE_INFINITY);
  });
});
