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
  PROHIBITED_LEET_FROM,
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
    'LPG regulator', 'Gas stove (4 burner)', 'Kerosene lamp',
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
    'R\u200Bum 750ml', 'Ru\u200Dm', 'R\uFEFFum', 'R\u00ADum', 'Rцm', 'Rum сake', 'Ｒｕｍ', 'ＲＵＭ\u3000７５０ｍｌ', 'R.U.M', 'R U M 750ml',
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
  const leet = (s: string, one: string) => [...s].map((ch) => { const k = (PROHIBITED_LEET_FROM + '1').indexOf(ch); return k >= 0 ? ('aaeiosstl' + one)[k]! : ch; }).join('');
  const kept = (raw: string) => {
    const s = sqlString(raw);
    const tokens = s.split(/[^a-z0-9]+/);
    return tokens.some((w) => prefilter.has(w)) || new RegExp(PROHIBITED_SINGLE_LETTER_RUN_PATTERN).test(s)
      || [leet(s, 'i'), leet(s, 'l')].some((t) => t.split(/[^a-z0-9]+/).some((w) => prefilter.has(w)))
      || tokens.some((w, k) => k + 1 < tokens.length && prefilter.has(w + tokens[k + 1]));
  };

  it('every listed word and brand-first word, disguised every way, is kept when the classifier catches it', () => {
    const disguises: Array<(t: string) => string> = [
      (t) => [...t].join('\u200B'),
      (t) => [...t].map((ch) => (ch === ' ' ? ch : String.fromCodePoint(ch.codePointAt(0)! + 0xFEE0))).join(''),
      (t) => t.replace(/o/g, 'о').replace(/a/g, 'а').replace(/e/g, 'е').replace(/c/g, 'с').replace(/p/g, 'р'),
      (t) => (t.includes(' ') ? t : [...t].join('.')),
      (t) => (t.includes(' ') ? t : [...t].join(' ').toUpperCase()),
      (t) => `${t[0]!.toUpperCase()}\u00AD${t.slice(1)} 750ml`,
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
    for (const raw of ['Rosé 750ml', 'ROSÉ', 'Rose\u0301 wine', 'R\u200Bum', 'Rцm', 'Ｒｕｍ', 'R.U.M']) expect(kept(raw), raw).toBe(true);
    // [evasion] l33t, plural and split spellings of every listed word and brand-first word are kept too.
    const leetOf = (t: string) => t.replace(/a/g, '4').replace(/e/g, '3').replace(/i/g, '1').replace(/o/g, '0').replace(/s/g, '$');
    let evasions = 0;
    for (const term of [...Object.values(PROHIBITED_TERMS).flat(), ...PROHIBITED_BRAND_FIRST_WORDS]) {
      const raws = [leetOf(term), `${term}s 6 pack`, term.length >= 5 && !term.includes(' ') ? `${term.slice(0, 3)} ${term.slice(3)}` : null].filter(Boolean) as string[];
      for (const raw of raws) {
        if (checkItem({ name: raw }).state === 'CLEAR') continue;
        evasions += 1;
        expect(kept(raw), `the pre-filter misses ${JSON.stringify(raw)} (${term})`).toBe(true);
      }
    }
    expect(evasions).toBeGreaterThan(800);
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

// [DS1109 S2/S3] What the first launch pass still let through, and what it refused that it should only hold.
describe('[§8 launch · DS1109] sold-as-such is refused; a dish or a garment named after a drink is held', () => {
  it.each([
    'Stella 6 pack', 'Rosés 750ml', 'Madeira 750ml', 'Marsala 750ml', 'Amaretto 750ml', 'Limoncello 500ml', 'Pisco 750ml', 'Pisco sour',
    'Dubonnet', 'Cinzano', 'Irish cream 750ml', 'Hard cider', 'Cider 750ml',
    'Snus', 'Heets', 'IQOS', 'Captain Black', 'Golden Virginia', 'Amber Leaf',
    'Banks 6 pack', 'Stag 12oz', 'Corona 12 pack', 'Tiger 24 pack', 'Bristol 20s', 'Camel 20 pack', 'B&H 20s', 'Velo 20 pouches',
    'Tiger Balm', 'Insulin', 'Kero oil 1L', 'Lighter fluid 250ml', 'Methylated spirits 500ml', 'Propane 20lb', '20lb gas cylinder', 'Diesel 5L',
    'Bong', 'CBD gummies', 'Ganja brownies', 'THC chocolate bar',
    'Guinness Foreign Extra Stout', 'Baileys Irish Cream', 'Johnnie Walker Black Label', 'Jack Daniels Old No. 7',
  ])('%s is refused outright', (name) => {
    expect(verdict(name)).toMatchObject({ state: 'BANNED', source: 'word' });
  });

  it.each([
    'Guinness cake', 'Baileys ice cream', 'Campari tomatoes', 'Jack Daniels BBQ sauce', 'Smirnoff vodka sauce', 'Vanilla rum extract cake',
    'Hennessy wings', 'Chicken Marsala', 'Madeira cake', 'Amaretto biscotti', 'Irish cream coffee creamer', 'Wine 8', 'Stout 42',
    'Cognac set', 'Champagne set', 'Banks', 'Banks birthday card', 'Tiger prawns 500g', 'Insulin cooler bag', 'Gas stove',
  ])('%s is held for a person, never refused', (name) => {
    expect(verdict(name).state, name).toBe('WAITING');
  });

  it('a non-alcoholic malt and an empty fuel can are ordinary goods', () => {
    for (const name of ['Malta Guinness', 'Guinness Malta 330ml', 'Gas can 5 gallon', 'Fuel can', 'Jerry can 20L']) expect(verdict(name), name).toEqual({ state: 'CLEAR' });
  });
});

// [DS1110] The second review's doors: more spirits, vapes and cigarettes sold as such; medicines with a form after
// the noun; cannabis by the gram; ready-mixed drinks; 18+ goods; and the false refusals it found.
describe('[§8 launch · DS1110] the second review', () => {
  it.each([
    'Mead 750ml', 'Mead bottle', 'Ricard 70cl', 'Grappa 750ml', 'Sambuca 700ml', 'Ouzo 750ml', 'Cachaça 700ml', 'Advocaat 750ml',
    'Pastis 70cl', 'Vodka Cruisers 4 pack', 'Wine coolers 4 pack', 'Four Loko', 'Havana Club 3 Year', 'Sailor Jerry', 'Disaronno',
    'Cointreau', 'Tsingtao 6 pack', 'Hairoun 6 pack',
    'Vuse pods', 'Vuse Alto', 'Relx pods', 'Newport 20s', 'Kool 20s', 'Winston 20s', 'Djarum Black',
    'Insulin 100 units', 'Insulin pen', 'Antibiotic cream 30g', 'Eye drops 10ml', 'Paracetamol syrup 100ml',
    'Weed 3.5g', 'Lottery ticket', 'Sex toy', 'Vibrator',
  ])('%s is refused outright', (name) => {
    expect(verdict(name)).toMatchObject({ state: 'BANNED', source: 'word' });
  });

  it.each([
    'Carib bean soup', 'Empty gas cylinder', 'Hard cider donuts', 'Mead notebook', 'Insulin cooler bag', 'Antibiotic-free chicken',
    'Wine cooler (12 bottle)', 'Concrete vibrator', 'Lottery results board', 'Rum and raisin stew', 'Weed',
  ])('%s is held for a person, never refused', (name) => {
    expect(verdict(name).state, name).toBe('WAITING');
  });

  it('a notebook brand and an empty cylinder are not banned goods', () => {
    expect(verdict('Mead five star notebook').state).not.toBe('BANNED');
    expect(verdict('Empty gas cylinder').state).not.toBe('BANNED');
  });
});

// [Coordinator, 14 Oct: commit security review "classifier evasion"] Each evasion class, probed and pinned. The text is
// normalised once at the classifier's entry; these are the spellings that still slipped through.
describe('[§8 launch · evasion] spellings that try to slip past the list', () => {
  it.each([
    ['Cherokee look-alike', 'Ꮃine 750ml'], ['small-capital look-alike', 'ᴠᴏᴅᴋᴀ 1L'],
    ['l33t', 'v4pe'], ['l33t', 'c1garette'], ['l33t', 'w1ne 750ml'], ['l33t', 'b33r 6 pack'], ['l33t symbol', 'Hennes$y VS'], ['l33t', 'V0DK@ 1L'],
    ['Spanish', 'Cerveza 6 pack'], ['Spanish', 'Ron 750ml'], ['French', 'Bière 330ml'], ['Spanish', 'Tabaco'], ['Spanish', 'Vino tinto 750ml'],
    ['Portuguese', 'Cerveja 6 pack'], ['Spanish', 'Cigarrillos 20s'],
    ['brand plural', 'Heinekens 6 pack'], ['brand plural', 'Coronas 6 pack'],
  ] as const)('%s: %s is refused outright', (_kind, name) => {
    expect(verdict(name)).toMatchObject({ state: 'BANNED' });
  });

  it.each([
    ['l33t, a word only', { name: 'a1cohol free hand gel' }], ['split word', { name: 'Hen nessy VS' }], ['split word', { name: 'Vod ka 1L' }],
    ['split across name and option', { name: 'Captain', optionNames: ['Morgan'] }], ['split across name and description', { name: 'Jack', description: 'Daniels' }],
  ] as const)('%s is held for a person: %o', (_kind, item) => {
    expect(checkItem(item).state).not.toBe('CLEAR');
  });

  it.each([
    'Vitamin B12', 'A4 paper (500 sheets)', 'PS5 controller', '4x4 tyre', 'Size 10 shoes', '7up 2L', 'Pine apple chunks', 'Banking app',
    'Galaxy Buds', 'MP3 player', 'G4 Plus phone case', 'Room 101 notebook', 'Cerulean blue paint',
  ])('ordinary goods with digits, plurals or split words stay clear: %s', (name) => {
    expect(verdict(name)).toEqual({ state: 'CLEAR' });
  });
});

// [DS1111, same round] Cannabis measures spelled out; a stationery pack and a sportswear brand are not banned goods;
// the high-volume shelf names the third review found.
describe('[§8 launch · DS1111] the third review', () => {
  it.each([
    'Weed 3.5 grams', 'Weed 1 gram', 'Weed ounce', 'Weed quarter', 'Weed eighth',
    'Fireball 750ml', 'Southern Comfort', 'Drambuie', 'Patrón 750ml', 'Beefeater 1L', 'Piton 6 pack', 'Kubuli 6 pack',
    'Bounty 750ml', 'Lambert & Butler', 'Davidoff 20s', 'Uwell Caliburn', 'Voopoo pods', 'Augmentin', 'Coartem', 'Otrivin',
  ])('%s is refused outright', (name) => {
    expect(verdict(name)).toMatchObject({ state: 'BANNED' });
  });

  it.each(['Lotto', 'Lotto sneakers', 'Mead five star notebook', 'Fireball candy', 'Bounty chocolate bar', 'Bounty 2 pack', 'Davidoff Cool Water',
    'Davidoff Cool Water 125ml', 'Halls 9 pack' /* #58: lozenges are held, never refused */])(
    '%s is not refused', (name) => {
      expect(verdict(name).state, name).not.toBe('BANNED');
    },
  );
});

// [Coordinator, 14 Oct: second commit security review "control regression" on af551644] What must stay REFUSED, as a
// name and as an option: a banned brand with ANY measure (volume, count, pack, age statement), and cannabis by any
// measure. (A lozenge pack is held by owner #58; a stationery or paper-towel pack named like a drink is held.)
describe('[§8 launch · regression guard] sold-as-such stays refused, in a name or an option', () => {
  const MUST_REFUSE = [
    'Hennessy 750ml', 'Hennessy VS', 'Banks 6 pack', 'Banks beer 12oz', 'Marlboro 20s', 'Marlboro Gold', 'Bristol cigarettes',
    'El Dorado 12 year', 'XM rum 5 yr', 'Smirnoff 1L', 'Guinness 6 pack', 'vape pen', 'juul pods', 'Panadol 24 tabs',
    'cough syrup 100ml', 'gas cylinder 20lb', 'LPG refill',
    'Weed 3.5g', 'Weed 1oz', 'Weed 3.5 grams', 'Weed ounce', 'Weed quarter', 'Ganja 1g', 'Kush 7g', 'Weed 2 joints', 'Weed pre-roll',
    'Pre-rolls 5 pack', 'Bounty 12 year old', 'Mead 10 years', 'Ron 7 años', 'Mead 3 pack', 'Ricard 6 pack', 'Ron 6 pack',
    'Camel 330ml', 'Newport 1L', 'Kool 12oz', 'Bayer 100ml', 'Velo 1L', 'Banks 330ml', 'Stag 6 pack', 'Corona 330ml', 'Bristol 20 pack',
  ];
  it.each(MUST_REFUSE)('%s is refused as a name', (name) => {
    expect(verdict(name)).toMatchObject({ state: 'BANNED' });
  });
  it.each(MUST_REFUSE)('%s is refused as an option', (name) => {
    expect(verdict('Party combo', { optionNames: ['Add', name] })).toMatchObject({ state: 'BANNED', field: 'option' });
  });
});
