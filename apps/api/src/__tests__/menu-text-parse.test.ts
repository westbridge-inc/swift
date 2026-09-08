import { describe, it, expect } from 'vitest';
import { parseMenuText } from '../utils/menu-text-parse';

// ---------------------------------------------------------------------------
// [NO-AI] The deterministic replacement for model-driven menu parsing.
//
// The old path sent the PDF's text to a model and asked for structured items.
// This reads what is on the page. It is deliberately conservative: a line that
// does not clearly carry a name and a price is SKIPPED, never guessed at. The
// vendor confirms every row in the existing preview step, so a miss costs one
// typed line; an invention costs a wrong price on a live product.
// ---------------------------------------------------------------------------

describe('[NO-AI] parseMenuText reads a menu instead of imagining one', () => {
  it('reads the shapes a menu PDF actually produces', () => {
    const drafts = parseMenuText([
      'STARTERS',
      'Pholourie ................ 500',
      'Egg Balls   $650',
      '2. Fish Cakes   G$1,200',
      '',
      'MAIN COURSES',
      'Chicken Curry (served with rice and dhal) .... 1,500.50',
      'Pepperpot – slow cooked with cassareep   2,250',
    ].join('\n'));

    expect(drafts).toEqual([
      { category: 'STARTERS', name: 'Pholourie', description: '', basePrice: 500 },
      { category: 'STARTERS', name: 'Egg Balls', description: '', basePrice: 650 },
      { category: 'STARTERS', name: 'Fish Cakes', description: '', basePrice: 1200 },
      { category: 'MAIN COURSES', name: 'Chicken Curry', description: 'served with rice and dhal', basePrice: 1500.5 },
      { category: 'MAIN COURSES', name: 'Pepperpot', description: 'slow cooked with cassareep', basePrice: 2250 },
    ]);
  });

  it('skips a line it cannot read rather than inventing a row', () => {
    const drafts = parseMenuText([
      'Open Tuesday to Sunday, 11am until late.',   // prose, no price
      '1500',                                        // a price with no name
      'Page 2',                                      // a page number, not an item
      'Ask your server about today’s special',       // prose
      'Real Item   900',                             // the only readable line
    ].join('\n'));

    expect(drafts.map((d) => d.name)).toEqual(['Real Item']);
  });

  it('does not turn a menu footer into priced products', () => {
    // Every line here was accepted as an item before the bare-integer floor was
    // removed: the floor rejected small naked numbers ("Page 2") and waved
    // through large ones, which is precisely the shape a phone number, a year
    // and a table number have. Found by independent review of #1218.
    const drafts = parseMenuText([
      'Call us on 592 226 1234',
      'Call us on 592 226   1234',            // same line, wider gap
      'Established 1998',
      'Serving Georgetown since 1998',
      'WhatsApp orders 592-600-1234',
      'Follow us on Instagram @swiftgy 2026',
      'Table 100',
      'Real Item   900',                      // the only readable line
    ].join('\n'));

    expect(drafts).toEqual([
      { category: 'Menu', name: 'Real Item', description: '', basePrice: 900 },
    ]);
  });

  it('still reads a numbered combo, because a dotted leader is a real menu convention', () => {
    // The guard above rejects a name ending mid-number when the only separator
    // is whitespace. It must NOT reject an item whose name legitimately ends in
    // a digit and is separated by a leader.
    const drafts = parseMenuText([
      'Combo 2 ............ 1500',
      'Combo 3   $1,800',
    ].join('\n'));
    expect(drafts.map((d) => [d.name, d.basePrice])).toEqual([['Combo 2', 1500], ['Combo 3', 1800]]);
  });

  it('refuses a price outside anything a menu line can mean', () => {
    const drafts = parseMenuText([
      'Suspiciously Cheap   0',
      'Phone Us On   5926015550',
      'Sensible Dish   1200',
    ].join('\n'));
    expect(drafts.map((d) => d.name)).toEqual(['Sensible Dish']);
  });

  it('does not treat a sentence as a category heading', () => {
    // A stray paragraph filed as a heading would mis-file every item after it.
    const drafts = parseMenuText([
      'All of our dishes are prepared fresh to order each day.',
      'Curry   1000',
    ].join('\n'));
    expect(drafts[0]?.category, 'the default stands').toBe('Menu');
  });

  it('never returns a nameless or priceless draft', () => {
    const drafts = parseMenuText([
      '   ....   750',
      '****   300',
      'Good One   450',
    ].join('\n'));
    for (const d of drafts) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(/[A-Za-z]/.test(d.name)).toBe(true);
      expect(d.basePrice).toBeGreaterThan(0);
    }
    expect(drafts.map((d) => d.name)).toEqual(['Good One']);
  });

  it('a small price still reads when the line SHOWS it is money', () => {
    // The bare-integer floor must not swallow a genuinely cheap item that is
    // written as money. Only a NAKED small number is treated as a page marker.
    expect(parseMenuText('Sweetie   $5').map((d) => d.basePrice)).toEqual([5]);
    expect(parseMenuText('Sweetie   5.00').map((d) => d.basePrice)).toEqual([5]);
    expect(parseMenuText('Sweetie ....... 5').map((d) => d.basePrice)).toEqual([5]);
    expect(parseMenuText('Chapter   5'), 'but a naked one is not').toEqual([]);
  });

  it('is total: junk in, empty out, never a throw', () => {
    for (const input of ['', '   ', '\n\n\n', '%%%%', String.fromCharCode(0)]) {
      expect(() => parseMenuText(input)).not.toThrow();
      expect(parseMenuText(input)).toEqual([]);
    }
    expect(parseMenuText(undefined as never)).toEqual([]);
  });

  it('truncates rather than letting a menu set field lengths', () => {
    const long = 'x'.repeat(400);
    const [draft] = parseMenuText(`${long} (${'y'.repeat(900)})   1000`);
    expect(draft!.name.length).toBeLessThanOrEqual(150);
    expect(draft!.description.length).toBeLessThanOrEqual(500);
  });
});
