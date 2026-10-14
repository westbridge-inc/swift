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
  PROHIBITED_BRAND_FIRST_WORDS,
  PROHIBITED_MARKS_PATTERN,
  PROHIBITED_PREFILTER_WORDS,
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
    'Paraffin wax candles', 'Wine gums', 'Brumley stool', 'Grumpy cat mug', 'Dry ginger ale 2L', 'Ginger beer (6 x 330ml)',
    'Rubbing Alcohol 70% (500ml)',
  ])('no hit on an ordinary item: %s', (text) => {
    expect(classifyText(text)).toBeNull();
  });

  // [DS1100 S2] An exemption names a soft drink; a qualifier in front of it makes it a drink
  // Swift does not carry. These were CLEAR before — a missed drink is the exposure ruled out.
  it.each([
    ['Hard ginger beer', 'ALCOHOL'], ['Spiked ginger beer', 'ALCOHOL'], ['Hard ginger ale', 'ALCOHOL'],
    ['Hard root beer', 'ALCOHOL'], ['Alcoholic ginger beer', 'ALCOHOL'], ['Spiked seltzer', 'ALCOHOL'],
    ['White Claw seltzer', 'ALCOHOL'], ['Truly seltzer', 'ALCOHOL'], ['Radler 330ml', 'ALCOHOL'], ['Boozy punch', 'ALCOHOL'],
    ['Cough drops (20)', 'MEDICINE'], ['Throat lozenges', 'MEDICINE'], ['Honey lozenge', 'MEDICINE'],
    // [DS1103 S2] a strength is a drink marker; the hard-drink family; brands written as one word
    ['5% ginger beer', 'ALCOHOL'], ['Ginger beer 5%', 'ALCOHOL'], ['8% ABV root beer', 'ALCOHOL'], ['Root beer 5% ABV', 'ALCOHOL'],
    ['Ginger beer 4.5% vol', 'ALCOHOL'], ['Strong ginger beer', 'ALCOHOL'], ['Extra strong ginger ale', 'ALCOHOL'],
    ['Hard tea', 'ALCOHOL'], ['Hard iced tea', 'ALCOHOL'], ['Hard kombucha', 'ALCOHOL'], ['Hard soda', 'ALCOHOL'],
    ['Truly Pineapple', 'ALCOHOL'], ['WhiteClaw mango', 'ALCOHOL'], ['JackDaniels', 'ALCOHOL'], ['GreyGoose', 'ALCOHOL'],
  ] as const)('a qualified or missing drink or medicine is caught: %s', (text, cls) => {
    expect(classifyText(text)).toMatchObject({ prohibitedClass: cls });
  });

  // [DS1104 S2] A brand's own label spelling: the possessive "'s" (straight or curly) and "&" for "and".
  // These were CLEAR before — "bailey's" read as "bailey s", "Wray & Nephew" as "wray nephew".
  it.each([
    ['Bailey\'s Irish Cream 750ml', 'ALCOHOL', 'baileys'], ['Bailey’s Original', 'ALCOHOL', 'baileys'],
    ['BAILEY\'S', 'ALCOHOL', 'baileys'], ['Buckley\'s Mixture', 'MEDICINE', 'buckleys'],
    ['Buckley’s Original Mixture 100ml', 'MEDICINE', 'buckleys'], ['Wray & Nephew 700ml', 'ALCOHOL', 'wray and nephew'],
    ['WRAY&NEPHEW Overproof', 'ALCOHOL', 'wray and nephew'],
  ] as const)('a label spelling is still the brand: %s', (text, cls, term) => {
    expect(classifyText(text)).toEqual({ prohibitedClass: cls, term });
  });

  it('the label spellings never lose a word the text already carried', () => {
    // Read only as joined, "Tobacco's" would be "tobaccos" — not a listed word; it is judged as written too.
    expect(classifyText('Tobacco\'s finest blend')).toEqual({ prohibitedClass: 'TOBACCO', term: 'tobacco' });
    expect(classifyText('Hennessy\'s VS')).toEqual({ prohibitedClass: 'ALCOHOL', term: 'hennessy' });
    expect(classifyText('Jack Daniel\'s 1L')).toMatchObject({ prohibitedClass: 'ALCOHOL' });
    expect(classifyText('Benson & Hedges Gold')).toMatchObject({ prohibitedClass: 'TOBACCO' });
    for (const ordinary of ['Mac & cheese', 'Fish & chips', 'Rock & roll burger', 'Pharmacist\'s choice soap', 'Children\'s rain boots', 'Ginger beer & lime']) {
      expect(classifyText(ordinary), ordinary).toBeNull();
    }
  });

  // [DS1105 S4] A strength in words or degrees; label spellings as they arrive from tills and typing.
  it.each([
    ['Six percent ginger beer', 'ALCOHOL', 'beer'], ['Ginger beer 5°', 'ALCOHOL', 'beer'], ['Ginger beer 5 °', 'ALCOHOL', 'beer'],
    ['Bailey \'s Irish Cream', 'ALCOHOL', 'baileys'], ['Wray n Nephew', 'ALCOHOL', 'wray and nephew'],
    ['Wray + Nephew 700ml', 'ALCOHOL', 'wray and nephew'], ['Wray &amp; Nephew', 'ALCOHOL', 'wray and nephew'],
  ] as const)('a strength or a spelling as written in the wild: %s', (text, cls, term) => {
    expect(classifyText(text)).toEqual({ prohibitedClass: cls, term });
  });

  it('apple cider vinegar is a grocery staple; cider is still cider', () => {
    for (const ordinary of ['Apple cider vinegar 500ml', 'Cider vinegar', 'Raw apple cider vinegar (with the mother)']) expect(classifyText(ordinary), ordinary).toBeNull();
    expect(classifyText('Apple cider 330ml')).toEqual({ prohibitedClass: 'ALCOHOL', term: 'cider' });
    expect(classifyText('Hard cider and cider vinegar')).toMatchObject({ prohibitedClass: 'ALCOHOL' });
  });

  // [DS1104 S3/S4] A soft drink's exemption goes when a strength or a qualifier appears ANYWHERE in the
  // text — after the phrase, as a comparative, or a strength written joined to its number.
  it.each([
    'Ginger beer strong', 'Stronger ginger beer', 'Ginger beer — the strongest', 'Ginger beer, extra strong', 'Root beer hard',
    'Ginger beer 6vol', 'Ginger beer 4.5abv', 'Root beer 12proof', 'Ginger beer volume', 'Ginger beer 5 percent', 'Ginger ale 5 per cent',
  ])('a soft drink with a strength or a qualifier anywhere is judged by its own word: %s', (text) => {
    expect(classifyText(text)).toMatchObject({ prohibitedClass: 'ALCOHOL' });
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

  it('the database pre-filter is a superset: every word and phrase, any accent, decomposed or not, any punctuation', () => {
    // The SQL reads each column as normalize() does: NFD, marks removed, lowercased, split on non-letters.
    const sqlWords = (raw: string) => raw.normalize('NFD').replace(new RegExp(PROHIBITED_MARKS_PATTERN, 'g'), '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const prefilter = new Set(PROHIBITED_PREFILTER_WORDS);
    const kept = (raw: string) => sqlWords(raw).some((w) => prefilter.has(w));
    const precomposed: Record<string, string> = { a: 'á', c: 'ç', e: 'é', g: 'ǵ', i: 'í', k: 'ḱ', l: 'ĺ', n: 'ñ', o: 'ó', r: 'ŕ', s: 'ś', u: 'ú', w: 'ẃ', y: 'ý', z: 'ź' };
    let checked = 0;
    for (const terms of Object.values(PROHIBITED_TERMS)) {
      for (const term of terms) {
        const variants = [
          term, term.toUpperCase(), term.replace(/ /g, ' — '), `Brand ${term} (750ml)`,
          [...term].map((ch) => precomposed[ch] ?? ch).join(''),
          [...term].map((ch) => (/[a-z]/.test(ch) ? `${ch}\u0301` : ch)).join(''),
          [...term].map((ch) => (precomposed[ch] ?? ch).toUpperCase()).join(''),
        ];
        for (const raw of variants) {
          if (!classifyText(raw)) continue;
          checked += 1;
          expect(kept(raw), `the pre-filter misses ${JSON.stringify(raw)}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(1500);
    // [DS1104 S2] Label spellings: any listed word ending in "s" written with a possessive "'s" (straight or curly),
    // and every "and" written "&". The SQL never joins the "'s", so the pre-filter must hold the stem too.
    let labelled = 0;
    for (const terms of Object.values(PROHIBITED_TERMS)) {
      for (const term of terms) {
        const words = term.split(' ');
        const variants = [term.replace(/ and /g, ' & '), term.replace(/ and /g, '&')];
        words.forEach((w, k) => {
          if (!w.endsWith('s') || w.length < 2) return;
          for (const apostrophe of ['\'', '’']) {
            variants.push(words.map((x, j) => (j === k ? `${x.slice(0, -1)}${apostrophe}s` : x)).join(' '));
            variants.push(`${words.map((x, j) => (j === k ? `${x.slice(0, -1)}${apostrophe}S` : x)).join(' ').toUpperCase()} 750ml`);
          }
        });
        for (const raw of variants) {
          if (!classifyText(raw)) continue;
          labelled += 1;
          expect(kept(raw), `the pre-filter misses ${JSON.stringify(raw)}`).toBe(true);
        }
      }
    }
    expect(labelled).toBeGreaterThan(400);
    for (const word of PROHIBITED_BRAND_FIRST_WORDS) {
      for (const raw of [`${word} Pineapple`, `${word.toUpperCase()} — mango`, `${word}\u2019s seltzer`]) {
        expect(checkItem({ name: raw }).state, raw).toBe('WAITING');
        expect(kept(raw), `the pre-filter misses ${JSON.stringify(raw)}`).toBe(true);
      }
    }
    for (const raw of ['Bailey\'s Irish Cream', 'Buckley’s Mixture', 'Wray & Nephew', 'Jack Daniel\'s']) {
      expect(classifyText(raw), raw).not.toBeNull();
      expect(kept(raw), raw).toBe(true);
    }
    for (const raw of ['Jägermeister', '\u015Atout', 'be\u0301er', 'E-Cigarette kit', 'Pepto-Bismol', 'Benson & Hedges', 'COOKING  GAS']) {
      expect(classifyText(raw), raw).not.toBeNull();
      expect(kept(raw), raw).toBe(true);
    }
    // Ordinary goods are not dragged into the exact check by the thousand.
    // ("liquid" must stay: "e-liquid" reads as "e liquid", and "e" would catch every "Vitamin E".)
    for (const word of ['morning', 'light', 'water', 'cooking', 'the', 'and', 'of', 'e', 'paper', 'pain', 'oil', 'bread', 'fresh']) {
      expect(prefilter.has(word), word).toBe(false);
    }
    expect(kept('Freshly made every morning by the bakery')).toBe(false);
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

  // [DS1105 S3] A qualifier in one of the item's own texts reaches the soft drink named in another:
  // name "Ginger Beer" with description "8 proof" was CLEAR in every field judged alone.
  it.each([
    [{ name: 'Ginger Beer', description: '8 proof' }, 'name'], [{ name: 'Ginger Beer', description: 'Strong' }, 'name'],
    [{ name: 'Ginger Beer', description: '6 vol.' }, 'name'], [{ name: 'Root beer', description: '4.5abv' }, 'name'],
    [{ name: 'Ginger ale', sectionName: 'Strong drinks' }, 'name'], [{ name: 'Fried chicken combo', description: '12proof', optionNames: ['Coke', 'Ginger beer'] }, 'option'],
  ] as const)('a qualifier in another field: %o', (item, field) => {
    expect(checkItem(item)).toMatchObject({ state: 'WAITING', prohibitedClass: 'ALCOHOL', field });
  });

  it('"Truly" is the seltzer brand at the head of a name or an option, an ordinary adverb in prose', () => {
    expect(checkItem({ name: 'Truly Pineapple' })).toMatchObject({ state: 'WAITING', prohibitedClass: 'ALCOHOL', field: 'name', term: 'truly' });
    expect(checkItem({ name: 'Wings combo', optionNames: ['Add a drink', 'Truly Mango'] })).toMatchObject({ state: 'WAITING', field: 'option', term: 'truly' });
    expect(checkItem({ name: 'Pepperpot', description: 'A truly Guyanese classic' })).toEqual({ state: 'CLEAR' });
    expect(checkItem({ name: 'Truly local bread', sectionName: 'Bakery' })).toMatchObject({ state: 'WAITING' }); // a name led by the brand word is held for a person
    expect(checkItem({ name: 'Bread', sectionName: 'Truly local' })).toEqual({ state: 'CLEAR' });
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
