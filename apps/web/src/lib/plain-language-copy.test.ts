import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A small census of the copy owned by COPY-FIX-1. Check rendered text and
// error fallbacks, without counting implementation comments.
const checks: Array<[string, RegExp]> = [
  ['../app/(app)/orders/[id]/page.tsx', /server[’']s cancellation quote|server result|cash-only late-cancellation marker|server-set order hold|server order hold|server history|the server reports|last server quote|late marker/i],
  ['../app/error.tsx', /\(ref \$\{error\.digest\}\)/],
  ['./auth.ts', /Request failed \(|Session expired\./],
  ['./customer.ts', /Request failed \(|updated delivery quote/],
  ['../app/signup/page.tsx', /Store location confirmed.*Latitude/],
  ['../app/selfie/page.tsx', /capture the camera frame|captured frame|sent as a JPEG/i],
  ['../app/qr/unavailable/page.tsx', /store may be offline or no longer public/i],
  ['../app/qr/retired/page.tsx', /counter code retired/i],
  ['../app/qr/not-found/page.tsx', /counter code retired/i],
  ['../app/(app)/store/[slug]/not-found.tsx', /store may no longer be public/i],
  ['../app/(marketing)/account/delete/page.tsx', /encryption key destroyed|push notification tokens/i],
];

describe('web plain language census', () => {
  it.each(checks)('%s does not bring back developer wording', (path, oldCopy) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(oldCopy);
  });
});
