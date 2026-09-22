import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const STACK = readFileSync(new URL('./VendorStack.tsx', import.meta.url), 'utf8');
const SCREEN = readFileSync(new URL('./screens/VendorAccessRecovery.tsx', import.meta.url), 'utf8');
const code = (value: string) => value
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('revoked vendor access recovery', () => {
  it('keeps forbidden access out of the vendor dashboard', () => {
    expect(code(STACK)).toMatch(/failure === 'forbidden'[\s\S]*!hasVendorOwnerAuthority[\s\S]*<BusinessSetup onLeave=\{chooseAnotherExperience\} \/>[\s\S]*<VendorAccessRecovery/);
    expect(code(STACK)).not.toContain("failure === 'forbidden' ? 'This account cannot open that store");
  });

  it('routes a first-time seller to the real become-partner flow', () => {
    expect(code(STACK)).toMatch(/roles[^\n]*includes\('VENDOR_OWNER'\)/);
    expect(code(STACK)).toMatch(/if \(!hasVendorOwnerAuthority\) return <BusinessSetup onLeave=\{chooseAnotherExperience\} \/>/);
  });

  it('clears the selected store and store-bound cache before retrying', () => {
    const retry = code(STACK).match(/const retryVendorAccess = \(\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? '';
    expect(retry).toMatch(/disconnectSocket\(\)/);
    expect(retry).toMatch(/setSelectedStore\(null\)/);
    expect(retry).toMatch(/resetQueries\(\{ queryKey: \['vendor'\] \}\)/);
  });

  it('can leave the business shell without granting business access', () => {
    const leave = code(STACK).match(/const openCustomerSwift = \(\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? '';
    expect(leave).toMatch(/disconnectSocket\(\)/);
    expect(leave).toMatch(/setSelectedStore\(null\)/);
    expect(leave).toMatch(/removeQueries\(\{ queryKey: \['vendor'\] \}\)/);
    expect(leave).toMatch(/setIntent\('customer'\)/);
    expect(leave).not.toMatch(/setAuth|myRole|vendorId/);
  });

  it('offers retry, customer Swift and sign-out exits', () => {
    expect(code(SCREEN)).toMatch(/label="Open Swift"/);
    expect(code(SCREEN)).toMatch(/label="Try store again"/);
    expect(code(SCREEN)).toMatch(/label="Choose another experience"/);
    expect(code(SCREEN)).toMatch(/label="Sign out"/);
    expect(code(SCREEN)).toContain('orders and data remain protected');
  });

  it('can return to the welcome experience picker without granting business access', () => {
    const leave = code(STACK).match(/const chooseAnotherExperience = \(\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? '';
    expect(leave).toMatch(/disconnectSocket\(\)/);
    expect(leave).toMatch(/setSelectedStore\(null\)/);
    expect(leave).toMatch(/removeQueries\(\{ queryKey: \['vendor'\] \}\)/);
    expect(leave).toMatch(/setIntent\(null\)/);
  });
});
