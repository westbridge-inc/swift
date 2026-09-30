import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (['__tests__', 'test', '__mocks__'].includes(e.name) ? [] : files(join(path, e.name))) : /\.(?:[cm]?[jt]sx?|html|json|css)$/.test(e.name) && !e.name.includes('.test.') && !e.name.includes('.spec.') ? [join(path, e.name)] : []);
}
const roots = ['src', '../web/src', '../web/public'];
export function retiredPaymentCopy(text: string) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return /\b(?:sanFormatted|payCashSteps|activationCopy)\b|(?:\?\.|\.)san\b|\[\s*[\x27\x22]san[\x27\x22]\s*\]|MMG[\s-]+agent|Swift[\s-]+Number|pay[^\n]{0,80}account[\s-]+number|(?:weekly fee|subscription)[^\n]{0,80}(?:paid by card|pay by card|pay in cash)|coming soon/i.test(code);
}
describe('partner checkout surface census', () => {
  it('no deprecated payload, agent instruction or teased method can be rendered', () => {
    const bad = roots.flatMap((r) => files(join(process.cwd(), r))).filter((f) => retiredPaymentCopy(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  it('the detector rejects a reintroduced agent row and all deprecated payload fields', () => {
    expect(retiredPaymentCopy(source('src/modules/vendor/screens/VendorAccountScreen.tsx'))).toBe(false);
    for (const text of ['<T>Pay the weekly fee at any MMG agent</T>', '<T>{sub.sanFormatted}</T>', '<T>{sub.san}</T>', '<T>{sub.payCashSteps}</T>', '<T>{sub.activationCopy}</T>', '<T>Coming soon</T>']) expect(retiredPaymentCopy(text)).toBe(true);
  });
  it('every partner stack mounts WeeklyFee and old pay navigation is gone', () => {
    for (const f of ['src/modules/vendor/VendorStack.tsx', 'src/modules/mover/MoverStack.tsx']) expect(source(f)).toContain('name="WeeklyFee"');
    for (const f of roots.flatMap((r) => files(join(process.cwd(), r)))) expect(readFileSync(f, 'utf8')).not.toMatch(/navigate\(['"](?:VendorMySwiftNumber|MySwiftNumber)['"]/);
  });
  it('phone checkout uses the auth browser with the fixed return and platform-scoped transport', () => {
    expect(source('src/modules/billing/screens/WeeklyFeeScreen.tsx')).toContain("WebBrowser.openAuthSessionAsync(url, 'swift://pay/mmg/return')");
    expect(source('src/services/api.ts')).toContain("config.headers['x-client-platform'] = Platform.OS");
  });
  it('the mobile and web state machines cannot drift', () => {
    expect(source('src/lib/weeklyFee.ts')).toBe(source('../web/src/lib/weekly-fee.ts'));
  });
});
