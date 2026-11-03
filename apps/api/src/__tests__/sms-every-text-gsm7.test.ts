/**
 * [SMS-COST · owner ruling 2 Nov 2026] Every SMS Swift sends is GSM-7, and an ops page text is short.
 *
 * One character outside the GSM 03.38 alphabet (a multiplication sign, an em dash, a curly quote)
 * bills the WHOLE text as UCS-2: 67 characters a part instead of 153. An on-call re-page of an
 * unacknowledged platform alert went out as eight paid parts, every half hour. Asserted here:
 *  1. SOURCE: every word written into an SMS (the literals passed to every SMS send, and the
 *     `sms:` / `feeSms:` texts handed to one) is GSM-7. A census keeps the list of senders whole.
 *  2. RENDERED: every SMS text builder, run with sample data, returns GSM-7; the ops texts fit
 *     two parts (the backup alert's re-page one), where the old re-page took eight.
 *  3. THE SEAM: whatever a sender hands it, the SMS provider posts GSM-7, and a GSM-7 text (a
 *     sign-in code) goes out exactly as written.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpsAlert, OpsAlertRecipient, OpsAlertKind } from '@prisma/client';
import { fitGsm7, gsm7Parts, gsm7Sms, isGsm7Message, toGsm7 } from '../utils/sms-text';
import { firstPageSms, repageWords, guyanaTime, drillBody } from '../modules/safety/ops-alert';
import { BACKUP_POSTURE_PAGE_TITLE } from '../modules/ops/backup-freshness';
import { CSAE_PAGE_BODY, CSAE_PAGE_TITLE } from '../modules/moderation/csae-page';
import { emergencyContactCodeText } from '../modules/safety/emergency-contact.service';
import { inactivityNoticeText } from '../modules/user/inactivity';
import { marketingSmsText } from '../modules/notification/marketing-message';
import { vendorAlertSmsText } from '../modules/notification/vendor-alert-sms';
import { passengerCheckinSms } from '../modules/safety/guardian-delivery';
import { failurePageWords, sosContactText, SOS_SMS_NAME_MAX } from '../modules/safety/sos-escalation';
import { sosClosedContactText } from '../modules/safety/sos.service';
import { FEE_RESTORE_LINE, feeCoveredLine, feeDueLine, mmgPayLine } from '../modules/billing/fee-notice-copy';
import { whenSentence } from '../modules/integrity/money-surface';
import { guyanaTime as adminGuyanaTime } from '../modules/admin/solo-approval';
import { devChannelLog, getChannels, resetDevChannelLog } from '../providers/notifications/channels';

const SRC = join(process.cwd(), 'src');

// ---------------------------------------------------------------------------
// 1. SOURCE
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', f: '\f', v: '\v' };
/** One escape sequence at `i` (just after the backslash): [the character, the index after it]. */
function escapeAt(src: string, i: number): [string, number] {
  const c = src[i]!;
  if (c === 'u' && src[i + 1] === '{') { const end = src.indexOf('}', i); return [String.fromCodePoint(parseInt(src.slice(i + 2, end), 16)), end + 1]; }
  if (c === 'u') return [String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)), i + 5];
  if (c === 'x') return [String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16)), i + 3];
  if (c === '\n') return ['', i + 1];
  return [ESCAPES[c] ?? c, i + 1];
}

/**
 * Walk one expression from `i`: every string and template literal's text goes to `out` (template
 * pieces apart, and the literals inside `${...}` too). Stops at the bracket that closes the
 * expression's group, or, with `atComma`, at a top-level comma or semicolon. Returns that index.
 */
function walk(src: string, i: number, atComma: boolean, out: string[]): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; let s = '';
      while (src[j] !== c) { if (src[j] === '\\') { const [ch, next] = escapeAt(src, j + 1); s += ch; j = next; } else s += src[j++]; }
      out.push(s); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let s = '';
      while (src[j] !== '`') {
        if (src[j] === '\\') { const [ch, next] = escapeAt(src, j + 1); s += ch; j = next; continue; }
        if (src[j] === '$' && src[j + 1] === '{') { out.push(s); s = ''; j = walk(src, j + 2, false, out) + 1; continue; }
        s += src[j++];
      }
      out.push(s); i = j + 1; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth -= 1; }
    else if (atComma && depth === 0 && (c === ',' || c === ';')) return i;
    i += 1;
  }
  return i;
}

/** The literals written into an SMS in one file: every SMS send's arguments (a named text is
 *  followed to its nearest `const` before the call) and every `sms:` / `feeSms:` text. */
function smsLiterals(src: string): string[] {
  const out: string[] = [];
  const call = /(\.sendSms|\.smsReach|(?<!function )\bsendSoloText)\(/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const open = m.index + m[0].length;
    const close = walk(src, open, false, out);
    for (const id of new Set(src.slice(open, close).match(/\b[A-Za-z_]\w*\b/g) ?? [])) {
      const decl = src.lastIndexOf(`const ${id} = `, m.index);
      if (decl >= 0) walk(src, decl + `const ${id} = `.length, true, out);
    }
  }
  const key = /\b(sms|feeSms)\s*:\s*/g;
  for (let m = key.exec(src); m; m = key.exec(src)) walk(src, m.index + m[0].length, true, out);
  return out;
}

/**
 * Every file that sends a text (the census: a new sender must be listed) and the files that write
 * a text another file sends. `min` = literals the scan must find there, so it can never pass by
 * finding nothing; 0 = the text is built by a function rendered in part 2.
 */
const SMS_TEXT_FILES: Record<string, { min: number; why: string }> = {
  'modules/admin/solo-approval.ts': { min: 4, why: 'owner approval notices' },
  'modules/ops/seed-plan.ts': { min: 4, why: 'solo re-seed code and notices' },
  'modules/auth/auth.service.ts': { min: 3, why: 'sign-in and reset codes, password-changed notice' },
  'modules/auth/step-up.ts': { min: 1, why: 'confirmation code' },
  'modules/integrity/money-surface.ts': { min: 3, why: 'MMG number / pay link change notices' },
  'modules/notification/notification.service.ts': { min: 0, why: 'vendor alert fallback (vendor-alert-sms.ts), fee texts (billing), direct texts' },
  'modules/notification/marketing-message.ts': { min: 0, why: 'the marketing door (marketingSmsText)' },
  'modules/safety/emergency-contact.service.ts': { min: 0, why: 'emergency-contact code (emergencyContactCodeText)' },
  'modules/safety/ops-alert.ts': { min: 0, why: 'on-call pages (firstPageSms, repageWords)' },
  'modules/safety/sos-escalation.ts': { min: 2, why: 'SOS to emergency contacts (sosContactText + its location line)' },
  'modules/safety/sos.service.ts': { min: 0, why: 'SOS closed notice to emergency contacts (sosClosedContactText)' },
  'modules/safety/trip-share.service.ts': { min: 2, why: 'trip-share link' },
  'modules/user/inactivity.ts': { min: 1, why: 'inactive-account notice' },
  'modules/billing/billing.service.ts': { min: 5, why: 'weekly-fee texts (feeSms / sms)' },
  'modules/billing/billing-notice-delivery.ts': { min: 1, why: 'billing history text' },
  'modules/safety/guardian-delivery.ts': { min: 0, why: 'passenger check-in text (passengerCheckinSms)' },
};

describe('[SMS-COST 1] every word written into an SMS is GSM-7', () => {
  const rel = (path: string) => relative(SRC, path).split('\\').join('/');
  const senders = sourceFiles(SRC).map(rel)
    .filter((r) => !r.startsWith('providers/notifications/'))
    .filter((r) => /\.(sendSms|smsReach)\(/.test(readFileSync(join(SRC, r), 'utf8')));

  it('the census: every file that sends a text is listed', () => {
    expect(senders.filter((r) => !(r in SMS_TEXT_FILES)), 'a new SMS sender: list it here so its words are checked').toEqual([]);
  });

  it.each(Object.entries(SMS_TEXT_FILES))('%s: every literal in its texts is GSM-7', (file, { min }) => {
    const literals = smsLiterals(readFileSync(join(SRC, file), 'utf8'));
    expect(literals.filter((l) => l.trim().length > 0).length, 'the scan found the texts it guards').toBeGreaterThanOrEqual(min);
    const bad = literals.filter((l) => !isGsm7Message(l)).map((l) => `${JSON.stringify(l)} -> ${[...l].filter((ch) => !isGsm7Message(ch)).join(' ')}`);
    expect(bad).toEqual([]);
  });

  it('the scan sees a non-GSM character when one is written (it is not blind)', () => {
    expect(smsLiterals('await sms.sendSms(to, `Order ${n} \u2014 ready`);').some((l) => !isGsm7Message(l))).toBe(true);
    expect(smsLiterals('const body = "It\u2019s here";\nawait this.channels.sms.sendSms(phone, body);').some((l) => !isGsm7Message(l))).toBe(true);
    expect(smsLiterals("return { feeSms: `Swift: pay \\u00d7 now` };").some((l) => !isGsm7Message(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. RENDERED
// ---------------------------------------------------------------------------

const AT = new Date('2026-11-01T14:05:00.000Z');
let ids = 0;
function alert(kind: OpsAlertKind, title: string, body: string, level: number, createdAt = AT): OpsAlert & { recipients: OpsAlertRecipient[] } {
  ids += 1;
  return {
    id: `c${String(ids).padStart(24, '0')}`, tenantId: null, kind, sosAlertId: kind === 'SOS' ? 'csos' : null, title, body,
    ackDeadlineAt: createdAt, acknowledgedAt: null, acknowledgedBy: null, escalationLevel: level, lastEscalatedAt: createdAt,
    oncallTextedLevel: 0, oncallTextedAt: null, oncallTextedList: null, closedAt: null, closeReason: null, createdAt, updatedAt: createdAt, recipients: [],
  };
}
/** The backup posture page's body with both of its findings (backup-freshness.ts checkBackupPosture). */
const BACKUP_BODY = "Backups still use the API's storage key: whoever obtains it can read, overwrite or delete every off-site backup. Create a key limited to the backup bucket and store it on the host (owner sheet BACKUP-KEY-SETUP). The last backup was not signed: restores refuse it. Install the backup store and the current backup unit on the host (sudo swift-secrets backup init).";
const SOS_TITLE = 'URGENT: SOS ACTIVE \u2014 respond now';
const SOS_BODY = 'CUSTOMER raised an SOS on order cmh1x2y3z4a5b6c7d8e9f0g1h. Open the war room now.';
/** Parts a text costs as UCS-2 (70 in one, 67 per part beyond), counted in UTF-16 units as carriers do. */
const ucs2Parts = (text: string) => (text.length <= 70 ? 1 : Math.ceil(text.length / 67));
/** What a phone is billed for a text: GSM-7 parts, or UCS-2 parts when any character is outside GSM-7. */
const billedParts = (text: string) => (isGsm7Message(text) ? gsm7Parts(text) : ucs2Parts(text));

describe('[SMS-COST 2] every SMS text builder renders GSM-7; ops texts fit two parts', () => {
  it('the backup alert re-page: eight UCS-2 parts before, ONE GSM-7 part now', () => {
    // the text exactly as the old ladder built it (ops-alert.ts before this change), cut at 480 as textOnCall cuts it
    const before = `Swift ops: UNACKNOWLEDGED (16\u00d7): ${BACKUP_POSTURE_PAGE_TITLE}. Acknowledge it in Mission Control > Ops alerts. ${BACKUP_BODY}`.slice(0, 480);
    expect(isGsm7Message(before)).toBe(false);
    expect(before).toHaveLength(480);
    expect(billedParts(before)).toBe(8);
    expect(billedParts(gsm7Sms(before))).toBe(4); // the provider seam alone halves it
    const after = repageWords([alert('PLATFORM', BACKUP_POSTURE_PAGE_TITLE, BACKUP_BODY, 16)]).text;
    expect(after).toBe('Swift ops: UNACKNOWLEDGED (16x): Backups are not protected from the API key. Acknowledge it in Mission Control > Ops alerts.');
    expect(isGsm7Message(after)).toBe(true);
    expect(billedParts(after)).toBe(1);
    // the first page of the same alert: one part, and no body in the text
    const first = firstPageSms({ kind: 'PLATFORM', title: BACKUP_POSTURE_PAGE_TITLE, body: BACKUP_BODY });
    expect(first).toBe('Swift ops: Backups are not protected from the API key. Acknowledge it in Mission Control > Ops alerts.');
    expect(billedParts(first)).toBe(1);
  });

  it('the push and inbox keep the full words; only the count sign changes (x, never \u00d7)', () => {
    const words = repageWords([alert('PLATFORM', BACKUP_POSTURE_PAGE_TITLE, BACKUP_BODY, 16)]);
    expect(words.title).toBe(`UNACKNOWLEDGED (16x): ${BACKUP_POSTURE_PAGE_TITLE}`);
    expect(words.body).toBe(`Nobody has acknowledged this alert since ${guyanaTime(AT)}. ${BACKUP_BODY} Acknowledge it now in Mission Control > Ops alerts.`);
    expect(words.title).not.toContain('\u00d7');
  });

  it('every ops page text is GSM-7, at most two parts, names the title and where to acknowledge it', () => {
    const cases: Array<[string, string]> = [
      ['first page: platform', firstPageSms({ kind: 'PLATFORM', title: BACKUP_POSTURE_PAGE_TITLE, body: BACKUP_BODY })],
      ['first page: CSAE', firstPageSms({ kind: 'PLATFORM', title: CSAE_PAGE_TITLE, body: CSAE_PAGE_BODY })],
      ['first page: drill', firstPageSms({ kind: 'DRILL', title: 'Ops alert drill \u2014 acknowledge now', body: drillBody(false) })],
      ['first page: SOS', firstPageSms({ kind: 'SOS', title: SOS_TITLE, body: SOS_BODY })],
      ['first page: a very long title', firstPageSms({ kind: 'PLATFORM', title: `\u201cLong\u201d ${'word '.repeat(80)}`, body: 'x'.repeat(900) })],
      ['first page: a very long SOS', firstPageSms({ kind: 'SOS', title: SOS_TITLE, body: `${SOS_BODY} ${'more '.repeat(200)}` })],
      ['re-page: one SOS', repageWords([alert('SOS', SOS_TITLE, SOS_BODY, 7)]).text],
      ['re-page: one drill', repageWords([alert('DRILL', 'Ops alert drill \u2014 acknowledge now', drillBody(true), 2)]).text],
      ['re-page: twenty, an SOS among them', repageWords([alert('SOS', SOS_TITLE, SOS_BODY, 1), ...Array.from({ length: 19 }, (_, i) => alert('PLATFORM', `Page ${i} \u2014 \u2018quoted\u2019`, BACKUP_BODY, 3))]).text],
      ['first page: an SOS whose line has a dash and a curly quote', firstPageSms({ kind: 'SOS', title: 'URGENT: SOS contact text failed \u2014 call the person now', body: 'The emergency contact\u2019s text failed \u2014 call them now.' })],
    ];
    for (const [name, text] of cases) {
      expect(isGsm7Message(text), name).toBe(true);
      expect(gsm7Parts(text), name).toBeLessThanOrEqual(2);
      expect(text, name).toMatch(/^Swift ops: /);
      expect(text, name).toMatch(/Acknowledge (it|them) in Mission Control > Ops alerts\./);
    }
    // an SOS keeps its short who/which-order line; any other page texts no body
    expect(cases[3]![1]).toBe(`Swift ops: URGENT: SOS ACTIVE - respond now. Acknowledge it in Mission Control > Ops alerts. ${SOS_BODY}`);
    expect(cases[0]![1]).not.toContain('storage key');
    expect(cases[1]![1]).not.toContain('moderation queue');
    expect(cases[8]![1]).toBe('Swift ops: 20 ops alerts are UNACKNOWLEDGED, including an SOS. First: URGENT: SOS ACTIVE - respond now. Acknowledge them in Mission Control > Ops alerts.');
    expect(cases[6]![1]).toBe(`Swift ops: UNACKNOWLEDGED (7x): URGENT: SOS ACTIVE - respond now. Acknowledge it in Mission Control > Ops alerts. ${SOS_BODY}`);
  });

  it('every other SMS text builder renders GSM-7 with sample data (names and store names included)', () => {
    const now = new Date('2026-11-02T15:00:00.000Z');
    const texts: Array<[string, string]> = [
      ['emergency contact', emergencyContactCodeText('Jos\u00e9', '482913')],
      ['emergency contact, a name outside GSM-7', emergencyContactCodeText('Ana Mar\u00eda \u{1F600}', '482913')],
      ['inactivity', inactivityNoticeText(new Date('2026-12-02T12:00:00.000Z')).sms],
      ['marketing', marketingSmsText('20% off your next order this weekend.')],
      ['vendor alert', vendorAlertSmsText({ orderNumber: 'SW-12345', storeName: 'Mama\u2019s \u201cBest\u201d Roti \u2014 Bar', cancelAt: new Date(now.getTime() + 4 * 60_000), now })],
      ['passenger check-in (HARD)', passengerCheckinSms({ title: 't', body: 'b', data: { sessionId: 's1', orderId: 'o1' }, answerToken: 'tok' }, 'HARD', 'https://swiftgy.com')],
      ['passenger check-in (SOFT)', passengerCheckinSms({ title: 't', body: 'b', data: { sessionId: 's1', orderId: 'o1' } }, 'SOFT', 'https://swiftgy.com')],
      ['fee: MMG pay line', mmgPayLine(8500, { alsoWebsite: true })],
      ['fee: due line', feeDueLine(8500, 'GYD', now, { first: true })],
      ['fee: covered line', feeCoveredLine(8500, 'GYD')],
      ['fee: restore line', FEE_RESTORE_LINE],
      ['money notice: when', `Swift: the MMG number on your store account changes ${whenSentence(now)}. If this wasn't you, open Swift > Account and cancel it now.`],
      ['solo approval: time', `It can be approved after ${adminGuyanaTime(now)}.`],
      ['ops: time', guyanaTime(now)],
      ['SOS to a contact', sosContactText('Jos\u00e9', ' Last known location: https://maps.google.com/?q=6.80448,-58.15527.')],
      ['SOS to a contact, a name outside GSM-7', sosContactText('\u674e\u660e', '')],
      ['SOS closed', sosClosedContactText('Ana Mar\u00eda')],
      ['SOS closed, an emoji-only name', sosClosedContactText('\u{1F600}')],
    ];
    for (const [name, text] of texts) expect(isGsm7Message(text), `${name}: ${JSON.stringify(text)}`).toBe(true);
  });

  it('[REVIEW-G4 S3-1] an SOS text never loses the person: a name GSM-7 cannot carry falls back to words', () => {
    expect(sosContactText('Jos\u00e9', '')).toBe('URGENT: Jos\u00e9 triggered an emergency SOS on Swift and may need help. Please check on them and contact local emergency services if you cannot reach them.');
    expect(sosContactText('\u674e\u660e', '')).toMatch(/^URGENT: Someone you know triggered an emergency SOS/);
    expect(sosContactText('\u{1F600}\u{1F600}', '')).toMatch(/^URGENT: Someone you know triggered/);
    expect(sosContactText(null, '')).toMatch(/^URGENT: Someone you know triggered/);
    expect(sosContactText('Ana Mar\u00eda', '')).toMatch(/^URGENT: Ana Maria triggered/);
    expect(sosClosedContactText('\u674e\u660e')).toMatch(/^Update from Swift: the emergency alert involving the person you were alerted about has been closed/);
    expect(sosClosedContactText('Jos\u00e9')).toMatch(/^Update from Swift: the emergency alert involving Jos\u00e9 has been closed/);
    expect(sosContactText('x'.repeat(80), '')).toBe(`URGENT: ${'x'.repeat(SOS_SMS_NAME_MAX)} triggered an emergency SOS on Swift and may need help. Please check on them and contact local emergency services if you cannot reach them.`);
    expect(sosClosedContactText('x'.repeat(80))).toContain(`involving ${'x'.repeat(SOS_SMS_NAME_MAX)} has been closed`);
    // [REVIEW-G5 S4-2, S4-3] punctuation alone is not a name; a phone's curly apostrophe stays an apostrophe
    expect(sosContactText('\u674e.', '')).toMatch(/^URGENT: Someone you know triggered/);
    expect(sosClosedContactText('\u{1F600}!')).toMatch(/involving the person you were alerted about has been closed/);
    expect(sosContactText('D\u2019Aguiar', '')).toMatch(/^URGENT: D'Aguiar triggered/);
    for (const t of [sosContactText('\u674e\u660e', ' Last known location: https://maps.google.com/?q=6.8,-58.1.'), sosClosedContactText('x'.repeat(80))]) {
      expect(isGsm7Message(t)).toBe(true);
      expect(gsm7Parts(t)).toBeLessThanOrEqual(2);
    }
  });

  it('[REVIEW-M3 S4-1 · REVIEW-G5 S4-4] a failed-delivery SOS page keeps its last sentence inside two parts, first page and re-page', () => {
    const id = 'c'.repeat(25);
    for (const channel of ['CONTACT_SMS', 'OPS_PAGE', 'WAR_ROOM', 'EVIDENCE'] as const) {
      for (const [row, last] of [[{ status: 'FAILED', attempts: 20 }, 'Swift stopped retrying after 20 attempts.'], [{ status: 'PENDING', attempts: 3 }, 'Swift keeps retrying.']] as const) {
        const { title, body } = failurePageWords(channel, id, row);
        expect(body.endsWith(last), `${channel}: ${body}`).toBe(true);
        for (const text of [firstPageSms({ kind: 'SOS', title, body }), repageWords([alert('SOS', title, body, 16)]).text]) {
          expect(gsm7Parts(text), `${channel}: ${text}`).toBeLessThanOrEqual(2);
          expect(text.endsWith(last), `${channel}: ${text}`).toBe(true);
        }
      }
    }
  });

  it('toGsm7 maps the characters that cost the most, and fitGsm7 keeps a text inside its parts', () => {
    expect(toGsm7('UNACKNOWLEDGED (16\u00d7) \u2014 \u2018a\u2019 \u201cb\u201d \u2026 \u2192 \u2264 \u2265 \u2013')).toBe('UNACKNOWLEDGED (16x) - \'a\' "b" ... -> <= >= -');
    const long = `Swift ops: ${'word '.repeat(200)}`;
    expect(gsm7Parts(fitGsm7(toGsm7(long), 2))).toBe(2);
    expect(fitGsm7(toGsm7(long), 2).endsWith('...')).toBe(true);
    expect(gsm7Parts(fitGsm7(toGsm7(long), 1))).toBe(1);
    expect(fitGsm7('short', 2)).toBe('short');
  });
});

// ---------------------------------------------------------------------------
// 3. THE SEAM
// ---------------------------------------------------------------------------

const RECIPIENT = '+5926000001';
const NASTY = `Swift: ${SOS_TITLE} \u2014 it\u2019s \u201curgent\u201d (3\u00d7) \u2026 caf\u00e9 Mar\u00eda \u{1F6A8}\nline two \u2192 done`;
const OTP = 'Your Swift verification code is: 482913';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetDevChannelLog(); });

describe('[SMS-COST 3] the SMS providers send GSM-7 whatever a sender hands them', () => {
  function twilio(): { bodies: string[] } {
    vi.stubEnv('SMS_RECIPIENT_ALLOWLIST', RECIPIENT);
    vi.stubEnv('NOTIFICATION_PROVIDER', 'twilio');
    vi.stubEnv('TWILIO_ACCOUNT_SID', `AC${'a'.repeat(32)}`);
    vi.stubEnv('TWILIO_API_KEY_SID', `SK${'b'.repeat(32)}`);
    vi.stubEnv('TWILIO_API_KEY_SECRET', 'test-key-secret');
    vi.stubEnv('TWILIO_FROM', '+15550000000');
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', '');
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(new URLSearchParams(init.body).get('Body') ?? '');
      return new Response(JSON.stringify({ sid: `SM${'c'.repeat(32)}` }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));
    return { bodies };
  }

  it('Twilio: a text with non-GSM characters is posted as GSM-7, line breaks kept', async () => {
    const { bodies } = twilio();
    await getChannels().sms.sendSms(RECIPIENT, NASTY);
    expect(bodies).toHaveLength(1);
    expect(isGsm7Message(bodies[0]!)).toBe(true);
    expect(bodies[0]).toBe('Swift: URGENT: SOS ACTIVE - respond now - it\'s "urgent" (3x) ... café Maria\nline two -> done');
  });

  it('Twilio: a GSM-7 text (a sign-in code) is posted exactly as written', async () => {
    const { bodies } = twilio();
    const multi = 'Line one [ref] {x} ~ | \\ \u20ac\nLine two';
    await getChannels().sms.sendSms(RECIPIENT, OTP);
    await getChannels().sms.sendSms(RECIPIENT, multi);
    expect(bodies).toEqual([OTP, multi]);
  });

  it('the dev adapter logs what Twilio would be sent', async () => {
    vi.stubEnv('NOTIFICATION_PROVIDER', 'dev');
    await getChannels().sms.sendSms(RECIPIENT, NASTY);
    await getChannels().sms.sendSms(RECIPIENT, OTP);
    const sms = devChannelLog.filter((e) => e.channel === 'sms' && e.to === RECIPIENT).map((e) => e.body);
    expect(sms).toEqual([gsm7Sms(NASTY), OTP]);
    expect(sms.every(isGsm7Message)).toBe(true);
  });
});
