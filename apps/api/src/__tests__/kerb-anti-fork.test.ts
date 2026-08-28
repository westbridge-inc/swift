import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * THE ANTI-FORK GATE — `SWIFT_KERB_AND_COCKPIT.md` Part 14 (K1–K3), and the
 * executable half of its build item 0.
 *
 * That document's own headline finding is that the kerb engine it specifies is
 * NOT a new subsystem: five of the subsystems it proposed building already
 * exist and ship today, on the delivery/cash rail. Building them again would
 * leave Swift with two enforcement ladders, two appeal state machines and two
 * compensation routes beside working ones.
 *
 * Its build item 0 is therefore "a written map of what attaches where, which
 * every later PR references". A map in prose goes stale silently, so this file
 * is that map — written as assertions, so it cannot.
 *
 * ── THE MAP ────────────────────────────────────────────────────────────────
 *
 * E1  ReimbursementClaim  (schema.prisma:719)  — the company guarantee.
 *     Written ONLY by `cash/cash-rules.service.ts:284`. `gpsLat`/`gpsLng` are
 *     NON-NULLABLE by design: the model's own comment says a claim is
 *     "impossible without" evidence. Admin review/pay routes already exist.
 *     ⇒ A taxi rider no-show is `reason: 'rider_no_show'` ON THIS MODEL.
 *
 * E2  Strike  (schema.prisma:758)  — the consequence primitive, with a phone
 *     and geo `addressKey` fingerprint that the risk score and the collusion
 *     checks already read. Written ONLY by `cash-rules.service.ts:216`.
 *     ⇒ A taxi no-show writes a Strike. No new counter.
 *
 * E3  EnforcementAction + EnforcementLevel + AppealStatus  (schema.prisma:3964,
 *     3882, 3889) — levelled rungs, a precise internal reasonCode, the evidence
 *     that fired as JSON, system-vs-human attribution, and a FOUR-STATE APPEAL
 *     MACHINE. `integrity/enforcement.ts` holds `hasActiveHold()` over a 30-day
 *     window and the one canonical copy block.
 *     ⇒ Kerb rungs are VALUES ADDED to `EnforcementLevel`; kerb appeals use
 *       `EnforcementAction.appeal`. Never a parallel table or a second enum.
 *
 * E4  The evidence format  — `cash-rules.service.ts:188`:
 *       `gps:${lat.toFixed(5)},${lng.toFixed(5)}` written into the immutable
 *       status-log note, plus the coordinates on the claim row.
 *     ⇒ Match it exactly, so one appeal view can read deliveries and rides.
 *
 * ── ONE CORRECTION TO THE DOCUMENT, measured from origin/main ──────────────
 *
 * Part 12.4 states the handover GPS "never computes a distance and never
 * refuses on proximity". The second half is right; the first is not.
 * `cash-rules.service.ts:279-282` DOES compute a haversine distance against a
 * per-country `maxHandoverDistanceKm` (default 0.75) and pushes a `gps_far`
 * flag, which routes the claim to PENDING_REVIEW instead of auto-approving.
 *
 * So the kerb engine's first build item — GPS-verified arrival — is NOT
 * starting from nothing. The primitive, the configured radius and, more
 * importantly, the PHILOSOPHY (flag into human review rather than refuse a
 * money outcome outright) already exist and should be reused. What genuinely
 * does not exist is proximity enforcement on the ARRIVAL transition.
 */

const SRC = join(process.cwd(), 'src');
const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments stripped — the standing hazard-matching rule. The map
 *  above necessarily NAMES every symbol these assertions ban elsewhere. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('///');
    })
    .join('\n');
}

const files = walk(SRC);
const rel = (f: string) => f.slice(join(process.cwd()).length + 1);

describe('K1 — one cancellation predicate', () => {
  // cancel-policy.ts exists BECAUSE the charge path and the customer preview
  // were once two independent literals with a "must match" comment. That is the
  // drift it was written to kill; this is what keeps it dead.
  it('only cancel-policy.ts declares the fee and the window', () => {
    const owners = files.filter((f) => /FREE_CANCEL_WINDOW_MIN\s*=|LATE_CANCEL_FEE\s*=/.test(code(f)));
    expect(owners.map(rel)).toEqual(['src/modules/order/cancel-policy.ts']);
  });

  it('nobody re-implements the free-window decision', () => {
    // A second predicate named like the real one is the fork.
    const forks = files.filter(
      (f) =>
        !f.endsWith('cancel-policy.ts') &&
        /function\s+(isFree\w*Cancel\w*|cancellationFee|freeCancellationExpiresAt)\s*\(/.test(code(f)),
    );
    expect(forks.map(rel)).toEqual([]);
  });

  it('the charge path and the preview both IMPORT it rather than re-deriving', () => {
    const policyImporters = files.filter((f) => /from\s+'[^']*cancel-policy'/.test(code(f))).map(rel);
    expect(policyImporters).toContain('src/modules/user/customer.routes.ts');
    expect(policyImporters).toContain('src/modules/order/order.service.ts');
  });
});

describe('K2 — one enforcement ladder, one appeal machine', () => {
  it('AppealStatus is declared exactly once', () => {
    expect(schema.match(/^enum AppealStatus \{/gm)?.length ?? 0).toBe(1);
  });

  it('EnforcementLevel is declared exactly once', () => {
    expect(schema.match(/^enum EnforcementLevel \{/gm)?.length ?? 0).toBe(1);
  });

  it('only EnforcementAction carries an appeal state', () => {
    // A second model with an appeal field is a second appeal machine, and the
    // two will diverge on what "UPHELD" means.
    const models = schema.split(/^model /m).slice(1);
    const withAppeal = models
      .filter((m) => /\n\s+appeal\s+AppealStatus/.test(m))
      .map((m) => m.split(/\s/)[0]);
    expect(withAppeal).toEqual(['EnforcementAction']);
  });

  it('kerb rungs, when added, are VALUES in EnforcementLevel — not a new enum', () => {
    // Guards the shape rather than the contents: this passes today and keeps
    // passing when behavioural rungs are added, but fails if someone declares a
    // parallel ladder enum instead.
    const ladderish = schema
      .match(/^enum \w*(Enforcement|Restriction|Ladder)\w*Level\w* \{/gm) ?? [];
    expect(ladderish.length).toBeLessThanOrEqual(1);
  });
});

describe('K3 — one compensation route, and it cannot exist without evidence', () => {
  it('a claim is structurally impossible without GPS', () => {
    // The model's own comment: "claim impossible without it". Making these
    // nullable would let a taxi no-show pay out on an unverifiable coordinate.
    const model = schema.split(/^model ReimbursementClaim \{/m)[1]?.split(/^\}/m)[0] ?? '';
    expect(model).toMatch(/gpsLat\s+Float\s*$/m);
    expect(model).toMatch(/gpsLng\s+Float\s*$/m);
    expect(model).not.toMatch(/gpsLat\s+Float\?/);
    expect(model).not.toMatch(/gpsLng\s+Float\?/);
  });

  it('exactly one module writes claims, and one writes strikes', () => {
    const claimWriters = files.filter((f) => /reimbursementClaim\.create\(/.test(code(f))).map(rel);
    const strikeWriters = files.filter((f) => /\bstrike\.create\(/.test(code(f))).map(rel);
    expect(claimWriters).toEqual(['src/modules/cash/cash-rules.service.ts']);
    expect(strikeWriters).toEqual(['src/modules/cash/cash-rules.service.ts']);
  });

  it('the evidence format has exactly one author', () => {
    // `gps:LAT,LNG` at 5dp, in the immutable status-log note. One appeal view
    // must be able to read deliveries and rides through the same lens.
    const authors = files.filter((f) => /gps:\$\{/.test(code(f))).map(rel);
    expect(authors).toEqual(['src/modules/cash/cash-rules.service.ts']);
  });
});

describe('the map is accurate — it fails if the machinery moves', () => {
  // A map that silently stops matching the tree is worse than no map, because
  // the next PR trusts it. These are the specific attachment points the kerb
  // engine is told to extend.
  const cashRules = code(join(SRC, 'modules/cash/cash-rules.service.ts'));

  it('handover still takes the outcome + gps shape the kerb engine extends', () => {
    expect(cashRules).toMatch(/outcome:\s*'paid'\s*\|\s*'no_show'\s*\|\s*'refused'/);
    expect(cashRules).toMatch(/gps:\s*\{\s*lat:\s*number;\s*lng:\s*number\s*\}/);
  });

  it('the proximity primitive the document says does not exist, does', () => {
    // Part 12.4 says the handover "never computes a distance". It does — with a
    // configured radius, flagging into human review rather than refusing. The
    // arrival check should reuse this, not reinvent it.
    expect(cashRules).toMatch(/haversineDistance\(/);
    expect(cashRules).toMatch(/maxHandoverDistanceKm/);
    expect(cashRules).toMatch(/gps_far/);
  });

  it('a flagged claim goes to review rather than auto-approving', () => {
    expect(cashRules).toMatch(/flags\.length === 0 \? 'AUTO_APPROVED' : 'PENDING_REVIEW'/);
  });
});
