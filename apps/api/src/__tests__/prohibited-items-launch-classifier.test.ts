/**
 * [GUARDRAILS §8] The prohibited-items rule before production accepts partner listings.
 *
 * Opus second review of #1649 (14 Oct 2026) and owner decisions #54–#59:
 *   · S1-LAUNCH-1 — the commonest Guyanese shelf names were CLEAR (XM without "rum",
 *     Bristol, "cigs", wine varietals, medicine brands, cannabis words…);
 *   · S1-LAUNCH-2 / #55 / #56 — anything SOLD as beer, wine or spirits (0.0 and
 *     alcohol-free included), cooking wine, rum essence and bitters are never
 *     approvable: the item itself is refused, not held for a reviewer;
 *   · S3-10 — disguised spellings (zero-width characters, Cyrillic or fullwidth
 *     look-alikes, dotted letters) read CLEAR;
 *   · #57 energy drinks and #58 vitamins and first aid stay allowed; lozenges are held.
 */
import { describe, it, expect } from 'vitest';
import {
  checkItem,
  classifyText,
  isHidden,
  judgedWordsHash,
  notAllowedMessage,
  PROHIBITED_BRAND_FIRST_WORDS,
  PROHIBITED_CONFUSABLES,
  PROHIBITED_FORMAT_CHARS_PATTERN,
  PROHIBITED_GOODS_NOUNS,
  PROHIBITED_MARKS_PATTERN,
  PROHIBITED_NEVER_APPROVABLE,
  PROHIBITED_PREFILTER_WORDS,
  PROHIBITED_ROSE_PATTERN,
  PROHIBITED_SINGLE_LETTER_RUN_PATTERN,
  PROHIBITED_TERMS,
} from '../modules/compliance/prohibited-items';

const verdict = (name: string, more: Record<string, unknown> = {}) => checkItem({ name, ...more });

describe('[§8 launch] the shelf names the list missed (Opus S1-LAUNCH-1)', () => {
  it.each([
    // rum and spirits
    'XM 10 Year Old', 'XM Gold 750ml', 'XM Supreme', 'Rhum Barbancourt', 'Old Parr 12', 'Courvoisier VS', 'Remy Martin',
    'Kahlua', 'Seagram\'s Gin', 'Black & White Scotch', 'Johnny Walker Black', 'Jose Cuervo Gold', 'Tanqueray', 'Campari 1L',
    // beer
    'Banks 6 pack', 'Stag 12oz', 'Bud', 'Corona', 'Modelo Especial', 'Tiger', 'Heineken 0.0',
    // wine
    'Chardonnay 750ml', 'Merlot', 'Cabernet Sauvignon', 'Rosé 750ml', 'Moscato', 'Pinot Grigio', 'Shiraz',
    // tobacco
    'Cigs 20 pack', 'Cig', 'Bristol 20s', 'B&H 20', 'Black & Mild', 'Swisher Sweets', 'Backwoods', 'Grabba leaf', 'Zyn pouches',
    // vapes and hookah
    'Lost Mary', 'Vaporizer pen', 'Hooka pipe', 'Sheesha', 'Al Fakher',
    // gas and fuel
    '20lb cylinder refill', 'LP refill', 'Kero oil 1L', 'Lighter fluid', 'Methylated spirits',
    // medicines
    'Benylin', 'Alka-Seltzer', 'Eno fruit salt', 'Tums', 'Pepto', 'Excedrin', 'Bayer 81mg', 'NyQuil', 'DayQuil', 'Sudafed',
    'Theraflu', 'Voltaren gel', 'Buscopan', 'Headache tablets', 'Fever reducer', 'Cough & Cold', 'Halls Mentholyptus',
    'Fishermans Friend', 'Cataflam 50mg',
    // cannabis
    'CBD gummies', 'Ganja', 'Weed brownies', 'Marijuana', 'Kush', 'THC vape', 'Cannabis oil',
  ])('%s is hidden from customers', (name) => {
    const check = verdict(name);
    expect(check.state, name).not.toBe('CLEAR');
    expect(isHidden(check), name).toBe(true);
  });

  it('cannabis is its own class, in plain words', () => {
    expect(classifyText('Ganja')).toEqual({ prohibitedClass: 'DRUGS', term: 'ganja' });
    expect(notAllowedMessage('DRUGS')).toBe('Swift doesn\'t allow this item: cannabis and illegal drugs.');
  });

  it('owner #58: lozenges are held for a person, never refused', () => {
    for (const name of ['Halls Mentholyptus', 'Fishermans Friend', 'Strepsils honey & lemon', 'Throat lozenges', 'Cough drops (20)']) {
      expect(verdict(name), name).toMatchObject({ state: 'WAITING', prohibitedClass: 'MEDICINE' });
    }
  });
});

describe('[§8 launch] never approvable: the item IS beer, wine, spirits, tobacco, a vape or a branded medicine (#55, #56, S1-LAUNCH-2)', () => {
  it.each([
    ['Legacy Rum', 'rum'], ['El Dorado 5 Year Rum', 'el dorado'], ['Red Wine 750ml', 'wine'], ['House wine', 'wine'],
    ['Heineken 0.0', 'heineken'], ['Non-alcoholic beer', 'beer'], ['Alcohol-free wine', 'wine'], ['Beer 0.0%', 'beer'],
    ['Beer, alcohol free (6 x 330ml)', 'beer'], ['Cooking wine', 'wine'], ['Rum essence 28ml', 'rum essence'],
    ['Angostura Aromatic Bitters', 'angostura'], ['Bitters 200ml', 'bitters'], ['Rum - Bristol White', 'rum'],
    ['Vodka, Russian Standard', 'vodka'], ['Carib Lager 6-pack', 'carib'], ['Hennessy VS', 'hennessy'], ['XM Gold', 'xm'],
    ['Rosé 750ml', 'rosewine'], ['Rum Gold 750ml', 'rum'], ['Rum punch (bottle)', 'rum punch'], ['Chardonnay', 'chardonnay'],
    ['Marlboro Red (20s)', 'marlboro'], ['Cigarettes 20s', 'cigarettes'], ['Disposable vape 5000 puffs', 'vape'],
    ['Panadol Extra 24s', 'panadol'], ['Paracetamol 500mg', 'paracetamol'], ['Ganja', 'ganja'],
  ] as const)('%s is refused outright (by "%s")', (name, term) => {
    expect(verdict(name)).toMatchObject({ state: 'BANNED', source: 'word', field: 'name', term });
  });

  it('an option that IS the drink makes the item one; a section or a description only holds it', () => {
    expect(verdict('Fried chicken combo', { optionNames: ['Add a drink', 'Coke', 'Carib Lager'] }))
      .toMatchObject({ state: 'BANNED', source: 'word', field: 'option', term: 'carib' });
    expect(verdict('Wings platter', { optionNames: ['Pair it with', 'Red wine'] })).toMatchObject({ state: 'BANNED', field: 'option' });
    expect(verdict('Bottle (750ml)', { sectionName: 'Beers & Wines' })).toMatchObject({ state: 'WAITING', field: 'section' });
    expect(verdict('Gift basket', { description: 'with a bottle of Hennessy' })).toMatchObject({ state: 'WAITING', field: 'description' });
  });

  it.each([
    'Rum cake', 'Beer batter fish', 'Beer-battered shrimp', 'Wine glass set (4)', 'Rum raisin ice cream', 'Champagne flutes (2)',
    'Stout work boots', 'Cigarette lighter adapter', 'Bourbon biscuits', 'Brandy snaps', 'Banks Kola Champagne', 'Tobacco pipe',
  ])('a word that is not the goods themselves is held for a person, never refused: %s', (name) => {
    expect(verdict(name).state, name).toBe('WAITING');
  });

  it('a colour or a size called "Wine", "Champagne" or "Stout" is held, not refused', () => {
    for (const option of ['Wine', 'Champagne', 'Stout', 'Cognac']) {
      expect(verdict('Maxi dress', { optionNames: ['Colour', option, 'Black'] }).state, option).toBe('WAITING');
    }
    expect(verdict('Heels - Champagne').state).toBe('WAITING');
  });

  it('approval never makes a never-approvable item visible', () => {
    const rum = { name: 'Legacy Rum' };
    expect(checkItem({ ...rum, reviewApprovedHash: judgedWordsHash(rum) }).state).toBe('BANNED');
    const cake = { name: 'Rum cake' };
    expect(checkItem({ ...cake, reviewApprovedHash: judgedWordsHash(cake) }).state).toBe('APPROVED');
  });

  it('every never-approvable word and goods noun is on the word list, so the database pre-filter keeps it', () => {
    const listed = new Set(Object.values(PROHIBITED_TERMS).flat());
    for (const term of [...PROHIBITED_NEVER_APPROVABLE, ...PROHIBITED_GOODS_NOUNS]) expect(listed.has(term), term).toBe(true);
  });
});

describe('[§8 launch] disguised spellings read as the word they hide (Opus S3-10)', () => {
  it.each([
    'R​um 750ml', 'Ru‍m', 'R﻿um', 'R­um', 'Rцm', 'Rum сake', 'Ｒｕｍ', 'ＲＵＭ　７５０ｍｌ', 'R.U.M', 'R U M 750ml',
    'V-O-D-K-A', 'G.I.N', 'Неineken', 'Ηennessy', 'Mаrlboro', 'ｖａｐｅ',
  ])('%s is not CLEAR', (name) => {
    expect(verdict(name).state, name).not.toBe('CLEAR');
  });

  it('ordinary single letters and ordinary non-Latin text stay clear', () => {
    for (const name of ['Size: S M L', 'A B C blocks', 'B.B.Q. sauce', 'T-bone steak', 'Pack of 2 x 3', 'Café latte', 'Crème brûlée']) {
      expect(verdict(name), name).toEqual({ state: 'CLEAR' });
    }
  });
});

describe('[§8 launch] what stays allowed (#57 energy drinks, #58 vitamins and first aid)', () => {
  it.each([
    'Red Bull 250ml', 'Monster Energy 473ml', 'Guru Energy', 'Vitamin C 1000mg', 'Multivitamin gummies', 'First aid kit',
    'Band-Aid plasters (20)', 'Antiseptic liquid 250ml', 'Bristol board (white)', 'Weed eater line', 'Weed killer 1L',
    'Seaweed snacks', 'Kola Champagne 2L', 'Virgin mojito', 'Virgin pina colada', 'Rubbing alcohol 70%', 'Budget rice 10lb',
    'Banking app voucher',
  ])('%s is clear', (name) => {
    expect(verdict(name), name).toEqual({ state: 'CLEAR' });
  });
});

describe('[§8 launch] the database pre-filter still keeps every disguised spelling (Opus S3-10)', () => {
  // The SQL, in JS: NFKC → format characters removed → look-alikes translated → "rosé" → NFD, marks
  // removed, lowercased, split on non-letters; a row is kept when it shares a word with the pre-filter
  // set, or carries two single letters in a row (the classifier joins "R.U.M" into "rum").
  const [FROM, TO] = [[...PROHIBITED_CONFUSABLES.from], [...PROHIBITED_CONFUSABLES.to]];
  const translate = (s: string) => [...s].map((ch) => { const k = FROM.indexOf(ch); return k >= 0 ? TO[k]! : ch; }).join('');
  const sqlString = (raw: string) => translate(raw.normalize('NFKC').replace(new RegExp(PROHIBITED_FORMAT_CHARS_PATTERN, 'gu'), ''))
    .replace(new RegExp(PROHIBITED_ROSE_PATTERN, 'g'), 'rosewine')
    .normalize('NFD').replace(new RegExp(PROHIBITED_MARKS_PATTERN, 'g'), '').toLowerCase();
  const prefilter = new Set(PROHIBITED_PREFILTER_WORDS);
  const kept = (raw: string) => {
    const s = sqlString(raw);
    return s.split(/[^a-z0-9]+/).some((w) => prefilter.has(w)) || new RegExp(PROHIBITED_SINGLE_LETTER_RUN_PATTERN).test(s);
  };

  it('every listed word and brand-first word, disguised every way, is kept when the classifier catches it', () => {
    const disguises: Array<(t: string) => string> = [
      (t) => [...t].join('​'),
      (t) => [...t].map((ch) => (ch === ' ' ? ch : String.fromCodePoint(ch.codePointAt(0)! + 0xFEE0))).join(''),
      (t) => t.replace(/o/g, 'о').replace(/a/g, 'а').replace(/e/g, 'е').replace(/c/g, 'с').replace(/p/g, 'р'),
      (t) => (t.includes(' ') ? t : [...t].join('.')),
      (t) => (t.includes(' ') ? t : [...t].join(' ').toUpperCase()),
      (t) => `${t[0]!.toUpperCase()}­${t.slice(1)} 750ml`,
    ];
    let checked = 0;
    for (const term of [...Object.values(PROHIBITED_TERMS).flat(), ...PROHIBITED_BRAND_FIRST_WORDS]) {
      for (const disguise of disguises) {
        const raw = disguise(term);
        if (checkItem({ name: raw }).state === 'CLEAR') continue;
        checked += 1;
        expect(kept(raw), `the pre-filter misses ${JSON.stringify(raw)} (${term})`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(2000);
    for (const raw of ['Rosé 750ml', 'ROSÉ', 'Rosé wine', 'R​um', 'Rцm', 'Ｒｕｍ', 'R.U.M']) expect(kept(raw), raw).toBe(true);
  });

  it('the format characters it removes are exactly Unicode\'s, and the look-alike table is one-to-one', () => {
    const pattern = new RegExp(`^${PROHIBITED_FORMAT_CHARS_PATTERN}$`, 'u');
    const cf = /^\p{Cf}$/u;
    const mismatched: string[] = [];
    for (let cp = 0; cp <= 0x10FFFF; cp += 1) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;
      const ch = String.fromCodePoint(cp);
      if (pattern.test(ch) !== cf.test(ch)) mismatched.push(`U+${cp.toString(16)}`);
    }
    expect(mismatched).toEqual([]);
    expect([...PROHIBITED_CONFUSABLES.from].length).toBe([...PROHIBITED_CONFUSABLES.to].length);
    expect(new Set([...PROHIBITED_CONFUSABLES.from]).size).toBe([...PROHIBITED_CONFUSABLES.from].length);
    for (const ch of PROHIBITED_CONFUSABLES.to) expect(ch, 'a look-alike maps to plain ASCII').toMatch(/^[A-Za-z]$/);
  });
});
