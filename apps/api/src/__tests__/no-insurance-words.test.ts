// [Owner rule, 5 Nov 2026] A promise Swift backs never says insurance or implies it, in any wording.
// Reads the strings a person can see on the unpaid-cash path, on every app. Code names (ReimbursementClaim,
// RLP_* codes, /claims routes, data keys) are not read by anyone and stay. Comments are not strings.
// Vehicle insurance documents are a separate subject and are not in these files.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const FILES = [
  'apps/api/src/modules/cash/cash-rules.service.ts',
  'apps/api/src/modules/cash/rlp.ts',
  'apps/api/src/modules/cash/claim-payout.ts',
  'apps/api/src/modules/chat/off-platform.ts',
  'apps/mobile/src/lib/parcelUnpaidWords.ts',
  'apps/mobile/src/modules/mover/claims-view.ts',
  'apps/mobile/src/modules/mover/screens/ClaimsScreen.tsx',
  'apps/admin/src/app/claims/page.tsx',
];
/** One line each from a larger file: the string that starts with this text. */
const LINES: Array<[file: string, starts: RegExp]> = [
  ['apps/api/src/jobs/queue.ts', /vendor–rider pair/],
  ['apps/api/src/modules/admin/admin.routes.ts', /identity can only be opened against an order/],
  ['apps/api/src/modules/user/partner-wind-down.ts', /Swift has not finished|Swift still owes you/],
  ['apps/api/src/modules/user/data-export-register.ts', /a mover made about an order of yours/],
  ['apps/mobile/src/modules/mover/screens/ActiveJobScreen.tsx', /Swift guarantee|Swift will pay you|under review|being reviewed|Your evidence and/],
  ['apps/mobile/src/modules/mover/screens/MoverAccountScreen.tsx', /[Gg]uarantee|Unpaid cash/],
  ['apps/mobile/src/services/notification-router.ts', /[Gg]uarantee|Unpaid cash/],
  ['apps/admin/src/components/layout/nav.ts', /decide and pay/],
  ['apps/admin/src/components/dashboard/AlertsPanel.tsx', /to decide$|to pay$/],
];

const SUSPENSION_WORDS = [
  'apps/api/src/modules/cash/cash-rules.service.ts',
  'apps/mobile/src/modules/mover/claims-view.ts',
  'apps/mobile/src/modules/mover/screens/ClaimsScreen.tsx',
];

const BANNED = /\b(insur\w*|guarantee\w*|loss[- ]protection|protection|protected|covers?|covered|cover\w*|premiums?|claims?|policy|policies|reserve)\b/i;
/** A sentence, so a data key or a code such as 'claim' or 'over_cap' is not read as words. */
const isWords = (s: string) => /\s/.test(s.trim());
/** The only string that stays: a Postgres trigger's text, identical to its migration; only logs see it. */
const FROZEN_SQL = /RAISE EXCEPTION/;

function stringsIn(file: string): string[] {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddleOrTemplateTail(node) || ts.isJsxText(node)) found.push(node.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found.map((s) => s.replace(/\s+/g, ' ').trim()).filter(isWords).filter((s) => !FROZEN_SQL.test(s));
}

describe('[owner rule] Swift-backed promises never say or imply insurance', () => {
  it.each(FILES)('%s', (file) => {
    const strings = stringsIn(file);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((s) => BANNED.test(s))).toEqual([]);
  });
  // A suspension is a person's decision after a finding, and it lasts until a person lifts it. Softer words are untrue.
  it.each(SUSPENSION_WORDS)('%s says suspended, never paused', (file) => {
    const strings = stringsIn(file).filter((s) => /automatic payment/i.test(s) && !/back on/i.test(s));
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((s) => !/suspended/i.test(s))).toEqual([]);
  });
  it.each(LINES)('%s: %s', (file, starts) => {
    const strings = stringsIn(file).filter((s) => starts.test(s));
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((s) => BANNED.test(s))).toEqual([]);
  });
});
