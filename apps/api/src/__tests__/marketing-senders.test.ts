/**
 * [R22 · research B13] Every marketing text and e-mail goes through marketing-message.ts, which
 * names Swift, says how to stop, and checks the consent ledger. This census reads the source:
 * every other file that sends an SMS or an e-mail is a listed SERVICE message (a code, an order
 * or safety notice, an admin approval). A new sender must be added here with its reason, or
 * send through marketing-message.ts. The admin broadcast's 'marketing' category stays in-app.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = join(process.cwd(), 'src');
const SEND = /\.(sendSms|sendEmail)\(/;

/** Files that send a text or an e-mail, each a service message (never an offer). */
const SERVICE_SENDERS: Record<string, string> = {
  'modules/admin/admin-email-change.ts': 'security notice to an admin e-mail address being replaced',
  'modules/admin/solo-approval.ts': 'the owner approval code for a privileged action',
  'modules/ops/seed-plan.ts': 'the owner sign-in code and notices for a solo production re-seed',
  'modules/auth/auth.service.ts': 'sign-in codes',
  'modules/auth/step-up.ts': 'confirmation codes for sensitive changes',
  'modules/integrity/money-surface.ts': 'money notices about a person\u2019s own payment',
  'modules/notification/notification.service.ts': 'order/fee fallbacks and alerts the person must get',
  'modules/safety/emergency-contact.service.ts': 'the emergency-contact verification code',
  'modules/safety/ops-alert.ts': 'operations pages for SOS',
  'modules/safety/sos-escalation.ts': 'SOS to emergency contacts',
  'modules/safety/sos.service.ts': 'SOS notices to emergency contacts',
  'modules/safety/trip-share.service.ts': 'the trip-share link the rider asked to send',
  'modules/user/inactivity.ts': 'the 30-day notice before an unused customer account is closed (R23 / C10)',
};
const MARKETING_SENDER = 'modules/notification/marketing-message.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('[R22] marketing texts and e-mails have one door', () => {
  const senders = sourceFiles(SRC)
    .map((path) => relative(SRC, path).split('\\').join('/'))
    .filter((rel) => !rel.startsWith('providers/notifications/'))
    .filter((rel) => SEND.test(readFileSync(join(SRC, rel), 'utf8')));

  it('every file that sends an SMS or an e-mail is a listed service sender or the marketing door', () => {
    const unlisted = senders.filter((rel) => rel !== MARKETING_SENDER && !(rel in SERVICE_SENDERS));
    expect(unlisted, `new SMS/e-mail sender(s): list as a service message with a reason, or send through ${MARKETING_SENDER}`).toEqual([]);
  });

  it('the list holds no stale entry, and the marketing door is a sender', () => {
    expect(Object.keys(SERVICE_SENDERS).filter((rel) => !senders.includes(rel))).toEqual([]);
    expect(senders).toContain(MARKETING_SENDER);
  });

  it('the admin broadcast (service or marketing) writes in-app notices only: it never texts or e-mails', () => {
    const admin = readFileSync(join(SRC, 'modules/admin/admin.routes.ts'), 'utf8');
    const start = admin.indexOf("app.post('/notifications/broadcast'");
    expect(start).toBeGreaterThan(0);
    const next = /\n {2}app\.(get|post|put|patch|delete)\(/.exec(admin.slice(start + 10));
    const handler = admin.slice(start, next ? start + 10 + next.index : undefined);
    expect(handler).not.toMatch(SEND);
    expect(handler).toContain("category === 'marketing'");
  });
});
