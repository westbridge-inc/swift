import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// SWIFT NEVER PAYS A MOVER.
//
// The customer hands over cash and the mover keeps it. Swift holds no order
// money at any point — that separation is the whole legal position, and it is
// why "Keep 100%" is literally true rather than marketing.
//
// "Payout" describes money Swift sends. It describes a transfer that does not
// exist. MoverOnboardingScreen shipped `label="Cash payouts"` on the screen
// where a person decides whether to work here — sitting directly beside
// "Keep 100%", which is the true version of the same claim. Beyond being
// false, a platform that says it pays people is a platform claiming to move
// their money, which is a regulatory statement nobody meant to make.
//
// This gate is scoped to the earner surfaces, deliberately. The web
// account-deletion page uses "payouts" while enumerating data categories in
// legal copy, and that is a copy review rather than a lie — a repo-wide ban
// would fail on legitimate text and get switched off, which is how gates die.
// ---------------------------------------------------------------------------

const MOVER_SURFACES = ['src/modules/mover', 'src/modules/movement'];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('Swift never pays a mover', () => {
  it('no earner-facing screen promises a "payout"', () => {
    const offenders: string[] = [];

    for (const surface of MOVER_SURFACES) {
      for (const file of walk(join(process.cwd(), surface))) {
        const src = readFileSync(file, 'utf8');
        // Comments are where the rule gets EXPLAINED, so they must not trip
        // it — the fixed pill carries a paragraph naming the banned phrase
        // directly above it, and a gate that fires on its own rationale is a
        // gate someone deletes. Block comments span lines, so this tracks the
        // state rather than stripping per line, which is the bug the first
        // version of this test shipped with.
        let inBlock = false;
        src.split('\n').forEach((line, i) => {
          let code = line;
          if (inBlock) {
            const end = code.indexOf('*/');
            if (end === -1) return;
            code = code.slice(end + 2);
            inBlock = false;
          }
          code = code.replace(/\/\*[\s\S]*?\*\//g, '');
          const open = code.indexOf('/*');
          if (open !== -1) {
            inBlock = true;
            code = code.slice(0, open);
          }
          code = code.replace(/\/\/.*$/, '');
          if (/payout/i.test(code)) {
            offenders.push(`${file.replace(process.cwd() + '/', '')}:${i + 1}  ${line.trim()}`);
          }
        });
      }
    }

    expect(
      offenders,
      `Swift never sends a mover money — the customer hands over cash and the mover keeps it.\n` +
        `Use "Cash in hand", never "payout".\n\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
