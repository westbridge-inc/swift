import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { customerCartKey } from './cart-key';
import { customerCartKey as shellCartKey } from './shell-data';

// [Size budget, main red 21 Oct] The checkout and the shell share ONE cart key. The checkout takes
// it from lib/cart-key: importing lib/shell-data made the checkout's own chunk carry a second
// copy of the shell's account reads (the checkout and cart pages went past their 158 kB ceiling).
describe('the saved cart key', () => {
  it('is one function: the shell re-exports the checkout’s key', () => {
    expect(shellCartKey).toBe(customerCartKey);
    expect(customerCartKey('c1', 2)).toEqual(['customer', 'cart', 'c1', 2]);
  });

  it('the checkout does not import the shell’s account reads', () => {
    const checkout = readFileSync(join(process.cwd(), 'src/components/checkout/checkout.tsx'), 'utf8');
    expect(checkout).not.toMatch(/from '@\/lib\/shell-data'/);
    expect(checkout).toMatch(/import \{ customerCartKey \} from '@\/lib\/cart-key';/);
  });
});
