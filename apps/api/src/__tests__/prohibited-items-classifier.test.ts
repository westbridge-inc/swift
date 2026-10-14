/**
 * [GUARDRAILS §8] The prohibited-items word list and verdicts — one server-side place, judged by whole words.
 *
 * Owner, 13 Oct 2026: alcohol, tobacco and cigarettes, vapes, every other 18+
 * item, all medicines (over-the-counter included), cooking gas (LPG) and fuel
 * are banned outright. A banned category or a person's removal refuses; a word
 * in the partner's own text holds the item for a quick check, and approval is
 * bound to the exact words a person saw.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkItem,
  classifyCategory,
  classifyText,
  isHidden,
  judgedWordsHash,
  notAllowedMessage,
  PROHIBITED_CLASSES,
  PROHIBITED_CLASS_LABELS,
  PROHIBITED_PREFILTER_PATTERN,
  PROHIBITED_TERMS,
  WAITING_FOR_CHECK,
} from '../modules/compliance/prohibited-items';
import { normalize } from '../modules/discovery/matcher';
import { REVIEW_PACK_STORES } from '../modules/review/content-pack';
import { SEED_TAXONOMY } from '../modules/discovery/taxonomy.seed';

describe('[§8] the word list: what is banned, judged by whole words', () => {
  it.each([
    ['Banks Beer 275ml', 'ALCOHOL', 'beer'],
    ['El Dorado 12 Year', 'ALCOHOL', 'el dorado'],
    ['XM Royal 10', 'ALCOHOL', 'xm royal'],
    ['Rum Punch', 'ALCOHOL', 'rum'],
    ['Rum cake', 'ALCOHOL', 'rum'],
    ['Beer batter fish', 'ALCOHOL', 'beer'],
    ['Gin & Tonic', 'ALCOHOL', 'gin'],
    ['House wine — red', 'ALCOHOL', 'wine'],
    ['Jägermeister shot', 'ALCOHOL', 'jagermeister'],
    ['Marlboro Red (20s)', 'TOBACCO', 'marlboro'],
    ['Rolling papers', 'TOBACCO', 'rolling papers'],
    ['Disposable vape — mango', 'VAPES', 'vape'],
    ['E-liquid 30ml', 'VAPES', 'e liquid'],
    ['Panadol Extra 24s', 'MEDICINE', 'panadol'],
    ['Vicks VapoRub 50g', 'MEDICINE', 'vicks'],
    ['Children\'s cough syrup 100ml', 'MEDICINE', 'cough syrup'],
    ['Lotto ticket', 'AGE_RESTRICTED', 'lotto'],
    ['Gas stove, 4 burner', 'LPG', 'gas'],
    ['Cooking gas refill 20lb', 'LPG', 'gas'],
    ['Propane tank', 'LPG', 'propane'],
    ['Kerosene (1 gallon)', 'FUEL', 'kerosene'],
    ['Diesel 5L', 'FUEL', 'diesel'],
    ['Paraffin oil', 'FUEL', 'paraffin'],
  ] as const)('%s → %s (by "%s")', (text, cls, term) => {
    expect(classifyText(text)).toEqual({ prohibitedClass: cls, term });
  });

  it.each([
    'Chicken drumstick (2pc)', 'Panama hat', 'Ginger tea', 'Original recipe wings', 'Gasket set', 'Vegas-style burger',
    'Pharmacist\'s choice soap', 'Maple syrup 250ml', 'Scotch bonnet pepper sauce', 'Malta 300ml', 'Mauby', 'Sorrel drink',
    'Digicel scratch card $500', 'Samsung tablet 10"', 'Coffee capsules (10)', 'Fruit cocktail 400g', 'Pill box organiser',
    'Ginger Beer 330ml', 'Root beer float', 'Canada Dry Ginger Ale', 'Rubbing Alcohol 70% 500ml', 'Alcohol swabs (100)',
    'Hand Sanitiser — alcohol-based hand gel', 'Polo shirt — wine coloured', 'Fuel filter (Toyota)', 'Diesel jeans',
    'Paraffin wax candles', 'Wine gums', 'Brumley stool', 'Grumpy cat mug',
  ])('no hit on an ordinary item: %s', (text) => {
    expect(classifyText(text)).toBeNull();
  });

  it('an exempt phrase is cut out and the rest is still judged', () => {
    expect(classifyText('Ginger beer and rum punch')).toEqual({ prohibitedClass: 'ALCOHOL', term: 'rum' });
    expect(classifyText('Non-alcoholic beer')).toMatchObject({ prohibitedClass: 'ALCOHOL' });
    expect(classifyText('Diesel jeans and a diesel can')).toEqual({ prohibitedClass: 'FUEL', term: 'diesel' });
    expect(classifyText('')).toBeNull();
    expect(classifyText(null)).toBeNull();
  });

  it('every class has words, every word is already normalized, and the classes read in plain words', () => {
    for (const cls of PROHIBITED_CLASSES) {
      expect(PROHIBITED_TERMS[cls].length, cls).toBeGreaterThan(0);
      for (const term of PROHIBITED_TERMS[cls]) expect(normalize(term), term).toBe(term);
    }
    expect(notAllowedMessage('ALCOHOL')).toBe('Swift doesn\'t allow this item: alcohol.');
    expect(notAllowedMessage('MEDICINE')).toBe('Swift doesn\'t allow this item: medicines.');
    expect(notAllowedMessage('LPG')).toBe('Swift doesn\'t allow this item: cooking gas (LPG).');
    expect(Object.keys(PROHIBITED_CLASS_LABELS).sort()).toEqual([...PROHIBITED_CLASSES].sort());
  });

  it('the database pre-filter is a superset: it finds every word and phrase, accents and punctuation included', () => {
    const pattern = new RegExp(PROHIBITED_PREFILTER_PATTERN, 'i');
    for (const terms of Object.values(PROHIBITED_TERMS)) for (const term of terms) expect(pattern.test(term), term).toBe(true);
    for (const raw of ['Jägermeister', 'E-Cigarette kit', 'Pepto-Bismol', 'Benson & Hedges', 'COOKING  GAS']) {
      expect(classifyText(raw), raw).not.toBeNull();
      expect(pattern.test(raw), raw).toBe(true);
    }
  });

  it('no setting can turn the ban off: the rule reads no environment variable', () => {
    for (const file of ['prohibited-items.ts', 'prohibited-gate.ts']) {
      const source = readFileSync(join(process.cwd(), 'src/modules/compliance', file), 'utf8');
      expect(source.includes('process.env'), file).toBe(false);
    }
  });
});

describe('[§8] the verdict on an item: certain bans refuse, a word holds it for a person', () => {
  const rumCake = { name: 'Rum cake', sectionName: 'Cakes', description: 'Guyanese classic', optionNames: ['Slice', 'Whole'] };

  it('a banned category or a removal is BANNED, whatever the words', () => {
    expect(checkItem({ name: 'Cold relief', categories: [{ slug: 'pharmacy', name: 'Pharmacy & Health' }] }))
      .toEqual({ state: 'BANNED', prohibitedClass: 'MEDICINE', source: 'category', term: 'pharmacy', reason: null });
    // A renamed category is still judged by its immutable slug.
    expect(checkItem({ name: 'Cold relief', categories: [{ slug: 'pharmacy', name: 'Health' }] })).toMatchObject({ state: 'BANNED' });
    expect(checkItem({ name: 'Mystery tonic', prohibitedAt: new Date(), prohibitedClass: 'MEDICINE', prohibitedReason: 'Sold as a cure' }))
      .toEqual({ state: 'BANNED', prohibitedClass: 'MEDICINE', source: 'removed', term: null, reason: 'Sold as a cure' });
  });

  it('a word hit WAITS until approved for those exact words; any edit brings the check back', () => {
    const waiting = checkItem(rumCake);
    expect(waiting).toEqual({ state: 'WAITING', prohibitedClass: 'ALCOHOL', field: 'name', term: 'rum' });
    expect(isHidden(waiting)).toBe(true);
    const approvedHash = judgedWordsHash(rumCake);
    const approved = checkItem({ ...rumCake, reviewApprovedHash: approvedHash });
    expect(approved.state).toBe('APPROVED');
    expect(isHidden(approved)).toBe(false);
    for (const edit of [
      { ...rumCake, name: 'Rum cake (large)' },
      { ...rumCake, description: 'Soaked in XM rum' },
      { ...rumCake, sectionName: 'Desserts' },
      { ...rumCake, optionNames: ['Slice', 'Whole', 'Add a shot of rum'] },
    ]) expect(checkItem({ ...edit, reviewApprovedHash: approvedHash }).state).toBe('WAITING');
    // Option order is not an edit.
    expect(judgedWordsHash({ ...rumCake, optionNames: ['Whole', 'Slice'] })).toBe(approvedHash);
  });

  it('approval never lifts a certain ban', () => {
    const banned = { ...rumCake, categories: [{ slug: 'alcohol', name: 'Alcohol' }] };
    expect(checkItem({ ...banned, reviewApprovedHash: judgedWordsHash(banned) }).state).toBe('BANNED');
    expect(checkItem({ ...rumCake, reviewApprovedHash: judgedWordsHash(rumCake), prohibitedAt: new Date(), prohibitedClass: 'ALCOHOL' }).state).toBe('BANNED');
  });

  it('a word anywhere in the partner\'s text holds the item, and says where', () => {
    expect(checkItem({ name: 'Bottle (750ml)', sectionName: 'Beers & Wines' })).toMatchObject({ state: 'WAITING', field: 'section' });
    expect(checkItem({ name: 'XM 10 Year', description: 'Premium aged rum' })).toMatchObject({ state: 'WAITING', field: 'description', term: 'rum' });
    expect(checkItem({ name: 'Fried chicken combo', optionNames: ['Add a drink', 'Coke', 'Carib Lager'] })).toMatchObject({ state: 'WAITING', field: 'option' });
    expect(checkItem({ name: 'Cook-up rice', sectionName: 'Mains' })).toEqual({ state: 'CLEAR' });
    expect(WAITING_FOR_CHECK).toBe('Waiting for a quick check');
  });

  it('the seeded taxonomy plants no banned category (Pharmacy left it); one named for a banned good would be banned', () => {
    expect(SEED_TAXONOMY.filter((c) => classifyCategory(c) !== null).map((c) => c.slug)).toEqual([]);
    expect(classifyCategory({ slug: 'pharmacy', name: 'Pharmacy & Health' })).toMatchObject({ prohibitedClass: 'MEDICINE' });
    expect(classifyCategory({ slug: 'alcohol', name: 'Alcohol' })).toMatchObject({ prohibitedClass: 'ALCOHOL' });
    expect(classifyCategory({ slug: 'wines-spirits', name: 'Wines & Spirits' })).toMatchObject({ prohibitedClass: 'ALCOHOL' });
    expect(classifyCategory({ slug: 'vape-shop', name: 'Vape shop' })).toMatchObject({ prohibitedClass: 'VAPES' });
    expect(classifyCategory({ slug: 'gas-fuel', name: 'Gas & Fuel' })).toMatchObject({ prohibitedClass: 'LPG' });
  });

  it('the App Review demo pack holds nothing back (its "alcohol hand gel" is a sanitiser)', () => {
    const lines = REVIEW_PACK_STORES.flatMap((s) => s.categories.flatMap((c) => c.items.map((i) => ({ name: i.name, description: i.description, sectionName: c.name }))));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.filter((l) => checkItem(l).state !== 'CLEAR')).toEqual([]);
    expect(lines.some((l) => /alcohol/i.test(l.description ?? ''))).toBe(true);
  });
});
