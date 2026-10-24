import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { orderLineOptionsText } from './orderLineOptions';

// [L09 · M026] The store makes what the customer chose: the order detail and
// the new-order takeover show each line's options under the item's name.

describe('a line\'s chosen options, as the store reads them', () => {
  it('names each choice under its group, in the order chosen', () => {
    expect(orderLineOptionsText([{ group: 'Size', name: 'Large' }, { group: 'Extras', name: 'Cheese' }])).toBe('Size: Large · Extras: Cheese');
  });

  it('a line with no options shows nothing', () => {
    expect(orderLineOptionsText([])).toBeNull();
    expect(orderLineOptionsText(undefined)).toBeNull();
    expect(orderLineOptionsText([{ group: 'Size', name: '' }])).toBeNull();
  });
});

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const DETAIL = strip(readFileSync(new URL('./screens/VendorOrderDetailScreen.tsx', import.meta.url), 'utf8'));
const TAKEOVER = strip(readFileSync(new URL('./NewOrderTakeover.tsx', import.meta.url), 'utf8'));

describe('both store order screens show the options', () => {
  it('the order detail shows each line\'s options', () => {
    expect(DETAIL).toContain('orderLineOptionsText(it.options)');
  });

  it('the new-order takeover shows each line\'s options', () => {
    expect(TAKEOVER).toContain('orderLineOptionsText(i.options)');
  });
});
