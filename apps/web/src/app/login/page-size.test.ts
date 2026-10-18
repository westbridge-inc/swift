import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF] The sign-in page needs one customer call (the code check), but it
// imported the whole customer client for it (lib/customer: cart, checkout,
// orders, rides, places...). That client is shared with the shopping pages, so
// the sign-in page's first load carried all of it. The code check now lives in
// its own small module, so the sign-in page loads only that. Its behaviour is
// unchanged (auth.test.ts pins the request; the login tests pin the flow).
// ---------------------------------------------------------------------------

const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
const loginPath = join(__dirname, '../../lib/customer-login.ts');
const login = existsSync(loginPath) ? readFileSync(loginPath, 'utf8') : '';
const customer = readFileSync(join(__dirname, '../../lib/customer.ts'), 'utf8');
const imports = (source: string) => source.split('\n').filter((line) => /^import\s/.test(line));

describe('[PERF] the sign-in page does not load the whole customer client', () => {
  it('takes the customer code check from its own small module, not from lib/customer', () => {
    expect(imports(page).filter((line) => /'@\/lib\/customer'/.test(line))).toEqual([]);
    expect(imports(page)).toContain("import { verifyCustomerLogin } from '@/lib/customer-login';");
  });

  it('keeps that module small: it imports only the shared sign-in code and the API origin', () => {
    expect(imports(login)).toEqual([
      "import { BROWSER_CLIENT, adoptSession } from './auth';",
      "import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';",
    ]);
    expect(login).toContain('export async function verifyCustomerLogin(');
  });

  it('has one home for the code check, so a test that stubs it cannot stub a copy', () => {
    expect(customer).not.toMatch(/verifyCustomerLogin/);
  });
});
