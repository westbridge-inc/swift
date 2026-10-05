import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { loggerRedactConfig } from '../utils/logger-config';
import { cardRailV2DrainEnabled, cardRailV2Enabled } from '../utils/card-rail';
import { cardRailWorkerSource } from '../modules/billing/card-rail-worker';
import { INSTRUMENT_DTO_SELECT } from '../modules/billing/card-rail.service';

// ---------------------------------------------------------------------------
// [PT-1] Source censuses for the card rail v2 laws that are about what the
// code may NEVER contain, rather than about what one run of it does:
//  - sub.paymentToken stays null: no code path writes it, and v2 never reads it;
//  - no card number, security code or PIN field anywhere in the v2 code [C1];
//  - the v2 provider interface has no raw-card method (AH.10.9.2);
//  - a card DTO is brand, last 4 and expiry [C9];
//  - a vault token never reaches a log line;
//  - CARD_RAIL_V2 is OFF unless it is exactly '1'.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

const V2_FILES = [
  'providers/card/card-provider.ts',
  'providers/card/simulator-provider.ts',
  'providers/card/card-rail-factory.ts',
  'modules/billing/card-rail.service.ts',
  'modules/billing/card-vault.ts',
  'modules/billing/card-observations.ts',
  'modules/billing/card-rail-worker.ts',
];

/** Every line of production source that names paymentToken. */
function paymentTokenLines(): Array<{ file: string; line: string }> {
  const files = sourceFiles(SRC);
  expect(files.length).toBeGreaterThan(200); // a broken walk must not pass vacuously
  return files.flatMap((f) => readFileSync(f, 'utf8').split('\n')
    .filter((l) => /\bpaymentToken\b/.test(l))
    .map((line) => ({ file: relative(SRC, f), line: line.trim() })));
}

describe('[PT-1] sub.paymentToken stays null', () => {
  it('no production code path writes it — not as a data field, not by assignment', () => {
    const writes = paymentTokenLines().filter(({ line }) => /\bpaymentToken\s*(:|=(?!=))/.test(line));
    expect(writes).toEqual([]);
  });

  it('the only readers are the two lines of the legacy card branch and one absence check; the v2 code never names it', () => {
    expect(paymentTokenLines()).toEqual([
      { file: 'modules/billing/billing.service.ts', line: "if (sub.billingMethod === 'CARD' && sub.paymentToken) {" },
      { file: 'modules/billing/billing.service.ts', line: 'token: sub.paymentToken,' },
      // [#1393] The one mover fee authority merges only trials with no payment
      // set up at all: it reads the legacy token solely to require its absence.
      { file: 'modules/subscription/mover-fee-authority.ts', line: "&& s.billingMethod === 'CASH' && !s.paymentToken && !s.mmgPayerMsisdn" },
    ]);
    for (const f of V2_FILES) expect(read(f), f).not.toMatch(/paymentToken/);
  });

  it('the v2 billing section (the instrument charge, its resume, its lookup, its holds, Pay now) never reads it', () => {
    const billing = read('modules/billing/billing.service.ts');
    const from = billing.indexOf('private async attemptInstrumentCharge(');
    const to = billing.indexOf('private amountFor(');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const section = billing.slice(from, to);
    expect(section).toMatch(/cardRail\.chargeInstrument\(/); // the slice really is the v2 charge
    expect(section).not.toMatch(/paymentToken/);
    // ...and the v2 dispatch sits in front of the legacy branch, gated by the flag.
    expect(billing.indexOf("sub.billingMethod === 'CARD' && cardRailV2Enabled()")).toBeGreaterThan(0);
    expect(billing.indexOf("sub.billingMethod === 'CARD' && cardRailV2Enabled()"))
      .toBeLessThan(billing.indexOf("sub.billingMethod === 'CARD' && sub.paymentToken"));
  });
});

describe('[C1] no card number, security code or PIN in the v2 code', () => {
  // The route census's own pattern (no-pan-in-routes.test.ts), applied to every v2 file.
  const FORBIDDEN = /\b(cardNumber|card_number|cardNo|ccNumber|pan|cvv|cvc|securityCode|cardVerification|pinBlock)\b\s*:/i;
  it('no v2 file declares such a field', () => {
    const offenders = V2_FILES.flatMap((f) => read(f).split('\n').map((l, i) => ({ f, i, l })).filter(({ l }) => FORBIDDEN.test(l)).map(({ f, i, l }) => `${f}:${i + 1} ${l.trim()}`));
    expect(offenders).toEqual([]);
  });

  it('the v2 provider interface has exactly its six methods — and none of them takes a raw card', () => {
    const src = read('providers/card/card-provider.ts');
    const body = src.slice(src.indexOf('export interface CardRailProvider {'), src.indexOf('\n}\n', src.indexOf('export interface CardRailProvider {')));
    const methods = [...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
    expect(methods).toEqual(['createSession', 'parseReturn', 'confirm', 'chargeInstrument', 'retrieve', 'refund']);
    expect(body).not.toMatch(/tokeni[sz]e|cardNumber|\bcvc\b|\bcvv\b|\bpan\b/i);
  });
});

describe('[C9] a card outside the vault is brand, last 4 and expiry', () => {
  it('the one DTO selection names exactly those (and the id and status the screen needs)', () => {
    expect(Object.keys(INSTRUMENT_DTO_SELECT).sort()).toEqual(['brand', 'expMonth', 'expYear', 'id', 'last4', 'status']);
  });
});

describe('a vault token never reaches a log line', () => {
  it('the production redaction config censors vaultToken, top level and nested', () => {
    let out = '';
    const sink = new Writable({ write(chunk, _enc, cb) { out += String(chunk); cb(); } });
    const logger = pino({ redact: loggerRedactConfig }, sink);
    logger.info({ vaultToken: 'simtok_ok_topsecret000000000000', charge: { vaultToken: 'simtok_ok_nestedsecret0000000000' } }, 'card charge');
    expect(out).not.toContain('topsecret');
    expect(out).not.toContain('nestedsecret');
    expect(out).toContain('[redacted]');
  });
});

describe('CARD_RAIL_V2 defaults OFF', () => {
  it('is on only for exactly "1"', () => {
    expect(cardRailV2Enabled({})).toBe(false);
    for (const v of ['', '0', 'true', 'yes', 'on', ' 1']) expect(cardRailV2Enabled({ CARD_RAIL_V2: v }), v).toBe(false);
    expect(cardRailV2Enabled({ CARD_RAIL_V2: '1' })).toBe(true);
  });
});

describe('[AX297 F5] with CARD_RAIL_V2 off the billing worker does no v2 work, unless CARD_RAIL_V2_DRAIN=1 asks it to drain', () => {
  const redis = {} as never; // never touched: no provider is built here

  it('draining is on only for exactly "1", and it is its own switch', () => {
    expect(cardRailV2DrainEnabled({})).toBe(false);
    for (const v of ['', '0', 'true', 'yes', ' 1']) expect(cardRailV2DrainEnabled({ CARD_RAIL_V2_DRAIN: v }), v).toBe(false);
    expect(cardRailV2DrainEnabled({ CARD_RAIL_V2_DRAIN: '1' })).toBe(true);
    expect(cardRailV2Enabled({ CARD_RAIL_V2_DRAIN: '1' })).toBe(false);
  });

  it('the worker wires a v2 provider only for CARD_RAIL_V2=1 or CARD_RAIL_V2_DRAIN=1, and builds none while wiring', () => {
    for (const env of [{}, { CARD_RAIL_V2: '0' }, { CARD_RAIL_V2: '0', CARD_RAIL_V2_DRAIN: '0' }, { CARD_RAIL_V2: 'true', CARD_RAIL_V2_DRAIN: 'yes' }]) {
      expect(cardRailWorkerSource({ redis }, env), JSON.stringify(env)).toBeUndefined();
    }
    // Wired, but lazy: an invalid configuration throws only when v2 work asks for the provider.
    for (const env of [{ CARD_RAIL_V2: '1' }, { CARD_RAIL_V2: '0', CARD_RAIL_V2_DRAIN: '1' }]) {
      const source = cardRailWorkerSource({ redis }, env);
      expect(typeof source, JSON.stringify(env)).toBe('function');
      expect(() => source!()).toThrow(/CARD_RAIL_PROVIDER is not set/);
    }
  });

  it('queue.ts wires card rail v2 only through those two functions: no provider and no card service of its own', () => {
    const queue = read('jobs/queue.ts');
    expect(queue).toContain('const cardRail = cardRailWorkerSource({ redis: ctx.redis });');
    expect(queue).toMatch(/sweepCardSessions\(\{ prisma: ctx\.prisma, notifications: [^}]+, billing, cardRail \}\)/);
    expect(queue).not.toMatch(/getCardRailProvider\(|new CardRailService\(/);
  });
});
