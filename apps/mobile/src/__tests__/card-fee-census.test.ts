import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CARD_RETURN } from '../lib/cardFee';

// [PT-3] The one weekly-fee page, card half. The owner's rules, made executable:
// the card processor is never named anywhere a partner can see it, Swift has no
// card-number field of its own, and the two apps share one card state machine.
const root = (path: string) => join(process.cwd(), path);
const source = (path: string) => readFileSync(root(path), 'utf8');
const SKIP_DIRS = new Set(['__tests__', 'test', '__mocks__', 'node_modules']);
function files(path: string, pattern: RegExp): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? (SKIP_DIRS.has(e.name) ? [] : files(join(path, e.name), pattern))
    : pattern.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts') ? [join(path, e.name)] : []);
}
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TEXT = /\.(?:html|json|css|svg|txt|webmanifest|js)$/;
/** Every module that ships in the phone app or the website, or that either imports (declaration files hold only types). */
const shipped = () => [
  ...files(root('src'), CODE), ...files(root('../web/src'), CODE), ...files(root('../../packages/ui/src'), CODE), ...files(root('../../packages/types/src'), CODE),
  root('app.config.ts'),
];
/** What a bundler keeps of a module: types and comments are gone, strings and markup stay. */
function emitted(path: string): string {
  return ts.transpileModule(readFileSync(path, 'utf8'), {
    fileName: path, compilerOptions: { removeComments: true, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}
const PROCESSOR = /power\s*-?\s*tranz/i;

describe('the card processor is never named to a partner', () => {
  it('appears in no string or markup of the phone app or the website (types and comments erased, as in the bundle)', () => {
    const list = shipped();
    expect(list.length).toBeGreaterThan(400);
    expect(list.filter((f) => PROCESSOR.test(emitted(f)))).toEqual([]);
  }, 60_000);
  it('appears in no static file the website or the phone app serves', () => {
    const statics = [...files(root('../web/public'), TEXT), ...files(root('assets'), TEXT)];
    expect(statics.filter((f) => PROCESSOR.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
  it('the detector sees a name in a string or in markup, and not in a type or a comment', () => {
    const probe = (code: string) => PROCESSOR.test(ts.transpileModule(code, { fileName: 'probe.tsx', compilerOptions: { removeComments: true, jsx: ts.JsxEmit.ReactJSX } }).outputText);
    expect(probe("export const a = 'Pay with PowerTranz';")).toBe(true);
    expect(probe('export const B = () => <p>Power Tranz</p>;')).toBe(true);
    expect(probe("export type P = 'POWERTRANZ' | 'MMG';\n// PowerTranz\nexport const c = 1;")).toBe(false);
  });
});

describe('Swift has no card field of its own', () => {
  const cardScreens = ['src/modules/billing/components/CardPaySection.tsx', '../web/src/components/card-pay.tsx'];
  it.each(cardScreens)('%s hosts no input, frame or web view; the number is typed only on the bank’s page', (path) => {
    const code = source(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/<(?:input|textarea|select|iframe|form|TextInput|LabeledInput|CodeInput|WebView)\b|keyboardType|secureTextEntry|textContentType|autoComplete|cc-number|cc-csc|onChangeText/);
  });
  it('the phone opens the card page in the in-app auth browser with the fixed card return', () => {
    expect(CARD_RETURN).toBe('swift://pay/card/return');
    expect(source('src/modules/billing/components/CardPaySection.tsx')).toContain('WebBrowser.openAuthSessionAsync(url, CARD_RETURN)');
  });
  it('the mobile and web card state machines cannot drift', () => {
    expect(source('src/lib/cardFee.ts')).toBe(source('../web/src/lib/card-fee.ts'));
  });
});
