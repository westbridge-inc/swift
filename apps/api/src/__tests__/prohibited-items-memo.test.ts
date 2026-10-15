import { describe, it, expect } from 'vitest';
import {
  checkItem,
  classifyCategory,
  judgeCategory,
  judgeItemWords,
  judgeStoreWords,
  prohibitedMemoSizes,
  storeWordHit,
  wordHit,
  PROHIBITED_BRAND_FIRST_WORDS,
  PROHIBITED_EXEMPT_PHRASES,
  PROHIBITED_GOODS_NOUNS,
  PROHIBITED_MEMO_MAX,
  PROHIBITED_TERMS,
  type ItemWords,
} from '../modules/compliance/prohibited-items';
import { SEED_TAXONOMY } from '../modules/discovery/taxonomy.seed';

// ---------------------------------------------------------------------------
// [PERF] Judging words is pure and slow (a few ms per item), and every menu,
// storefront and Market read judged every item it showed, again, on every
// request. The judges now remember answers for the exact words given. What
// must never change: a verdict. Every case below compares the remembered
// answer with a fresh judgement, cold and warm. Synthetic words only.
// ---------------------------------------------------------------------------

const terms = Object.values(PROHIBITED_TERMS).flat();
const words = [...new Set([...terms, ...PROHIBITED_BRAND_FIRST_WORDS, ...PROHIBITED_EXEMPT_PHRASES, ...PROHIBITED_GOODS_NOUNS])];
const clean = ['Curry chicken plate', 'Pepperpot bowl', 'Claw hammer', 'Lemonade', 'Ginger beer', 'Root beer float', 'Rum cake', 'Wine gums', 'Beer-battered fish'];

/** Every listed word in the places a partner writes words, plus clean menus and near-misses. */
const corpus: ItemWords[] = [
  ...words.flatMap((word, i) => [
    { name: i % 2 ? word : `${word.toUpperCase()} PACK of 20s` },
    i % 3 === 0 ? { name: 'Combo', sectionName: `${word} & more` } : i % 3 === 1 ? { name: 'House special', description: `Served with ${word}` } : { name: 'Combo', optionNames: ['Add a drink', `Cold ${word} 750ml`] },
  ]),
  ...clean.flatMap((name) => [{ name }, { name, description: 'Made fresh', sectionName: 'Mains', optionNames: ['Small', 'Large', null, undefined, ''] }]),
];

describe('remembered verdicts (PERF): never a different verdict', () => {
  it('every item word judged by the table equals a fresh judgement, cold and warm', () => {
    for (const pass of ['cold', 'warm']) {
      for (const item of corpus) expect(wordHit(item), `${pass}: ${JSON.stringify(item)}`).toEqual(judgeItemWords(item));
    }
  }, 120_000);

  it('the whole item verdict is the same, cold and warm', () => {
    const first = corpus.map((item) => checkItem(item));
    expect(corpus.map((item) => checkItem(item))).toEqual(first);
    expect(first.filter((check) => check.state !== 'CLEAR').length).toBeGreaterThan(words.length / 2);
  }, 120_000);

  it('the same words in a different field or order are judged as themselves, never as another item', () => {
    const pairs: ItemWords[][] = [
      [{ name: 'Lemonade', description: 'with rum' }, { name: 'with rum', description: 'Lemonade' }],
      [{ name: 'Combo', optionNames: ['Beer', 'Cigarettes'] }, { name: 'Combo', optionNames: ['Cigarettes', 'Beer'] }],
      [{ name: 'Combo', sectionName: 'Beer' }, { name: 'Combo', description: 'Beer' }],
      [{ name: 'Combo', description: null }, { name: 'Combo', description: '' }, { name: 'Combo' }],
      [{ name: 'Combo', optionNames: ['Beer'] }, { name: 'Combo Beer' }, { name: 'Combo', optionNames: ['Beer', null] }],
    ];
    for (const pair of pairs) {
      for (const item of [...pair, ...pair]) expect(wordHit(item), JSON.stringify(item)).toEqual(judgeItemWords(item));
    }
  });

  it('a store’s words and a platform category are judged as fresh judgements are, cold and warm', () => {
    const stores = [...words.slice(0, 200).map((word) => ({ name: `${word} Shop` })), { name: 'Banks Hardware', description: 'Tools', tags: ['hardware'], cuisineTypes: [] }, { name: 'Sample Kitchen', tags: [null, 'wine'], cuisineTypes: ['Creole'] }, { name: 'Corner Shop', tags: ['bread'] }, { name: 'Corner Shop', tags: ['wine'] }, { name: 'Corner Shop', cuisineTypes: ['wine'] }];
    const categories = [...SEED_TAXONOMY.map((c) => ({ slug: c.slug, name: c.name })), { slug: 'beer-wine', name: 'Beer & Wine' }, { slug: 'pharmacy', name: 'Health' }, { slug: 'groceries', name: 'Groceries' }, { slug: 'groceries', name: 'Beer & Wine' }];
    for (let pass = 0; pass < 2; pass++) {
      for (const store of stores) expect(storeWordHit(store), store.name).toEqual(judgeStoreWords(store));
      for (const category of categories) expect(classifyCategory(category), category.slug).toEqual(judgeCategory(category));
    }
  }, 120_000);

  it('a caller changing the answer it got changes no other caller’s answer', () => {
    const item = { name: 'Cold beer 750ml' };
    const hit = wordHit(item)!;
    expect(hit).not.toBeNull();
    (hit as { term: string }).term = 'changed';
    (hit as { certain: boolean }).certain = !hit.certain;
    expect(wordHit(item)).toEqual(judgeItemWords(item));
    const store = storeWordHit({ name: 'Rum Shop' })!;
    (store as { term: string }).term = 'changed';
    expect(storeWordHit({ name: 'Rum Shop' })).toEqual(judgeStoreWords({ name: 'Rum Shop' }));
  });

  it('remembers at most PROHIBITED_MEMO_MAX answers per judge, and still answers correctly past it', () => {
    for (let i = 0; i < PROHIBITED_MEMO_MAX + 50; i++) wordHit({ name: `Plain item number ${i}` });
    expect(prohibitedMemoSizes().items).toBeLessThanOrEqual(PROHIBITED_MEMO_MAX);
    expect(wordHit({ name: 'Cold beer 750ml' })).toEqual(judgeItemWords({ name: 'Cold beer 750ml' }));
  }, 60_000);

  it('a menu read again is judged from the table: far faster than judging it', () => {
    const menu = Array.from({ length: 100 }, (_, i) => ({ name: `Sample dish ${i} with chicken and rice`, description: 'A made-up dish, served hot.', sectionName: `Section ${i % 8}`, optionNames: ['Size', 'Regular', 'Large'] }));
    let at = performance.now();
    for (const item of menu) wordHit(item);
    const cold = performance.now() - at;
    at = performance.now();
    for (const item of menu) wordHit(item);
    const warm = performance.now() - at;
    expect(warm * 10).toBeLessThan(cold);
  });
});
