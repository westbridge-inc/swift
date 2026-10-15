/**
 * [GUARDRAILS §8 · R4] The expanded permanent list (owner, 15 Oct 2026; research A6 and A8).
 *
 * Banned the same way as alcohol and tobacco — no switch, no licence on file, no reviewer can make them sellable:
 * fireworks, squibs and other explosives; pesticides and toxic chemicals; raw gold, diamonds and precious stones;
 * firearms, ammunition and replicas; protected wildlife; counterfeit goods; currency and payment cards; and legal
 * services (advertising them is barred to "any person whatsoever"). Lottery and gambling products and adult goods
 * were already the 18+ class; more of their names are caught now.
 *
 * Each class answers like the old ones: a name or an option that IS the goods is refused outright; a word that
 * only mentions it holds the item for a person; a parcel naming it is refused. The ordinary goods that share a
 * word — a glue gun, gunpowder tea, a gold chain, a credit-card holder — stay clear.
 */
import { describe, it, expect } from 'vitest';
import {
  checkItem,
  classifyText,
  notAllowedMessage,
  offersLegalServices,
  parcelProhibited,
  PROHIBITED_CLASSES,
  PROHIBITED_CLASS_LABELS,
  storeWordHit,
} from '../modules/compliance/prohibited-items';

const NEW_CLASSES = ['EXPLOSIVES', 'PESTICIDES', 'PRECIOUS_MINERALS', 'WEAPONS', 'WILDLIFE', 'COUNTERFEIT', 'CURRENCY', 'LEGAL_SERVICES'] as const;

describe('[§8 · R4] the new classes, in plain words', () => {
  it('every new class is on the permanent list, with the words a partner reads', () => {
    for (const cls of NEW_CLASSES) expect(PROHIBITED_CLASSES, cls).toContain(cls);
    expect(Object.fromEntries(NEW_CLASSES.map((cls) => [cls, PROHIBITED_CLASS_LABELS[cls as keyof typeof PROHIBITED_CLASS_LABELS]]))).toEqual({
      EXPLOSIVES: 'fireworks and explosives',
      PESTICIDES: 'pesticides and toxic chemicals',
      PRECIOUS_MINERALS: 'raw gold, diamonds and precious stones',
      WEAPONS: 'firearms, ammunition and replicas',
      WILDLIFE: 'protected wildlife',
      COUNTERFEIT: 'counterfeit goods',
      CURRENCY: 'currency and payment cards',
      LEGAL_SERVICES: 'legal services',
    });
    expect(notAllowedMessage('WEAPONS' as never)).toBe('Swift doesn\'t allow this item: firearms, ammunition and replicas.');
    expect(notAllowedMessage('LEGAL_SERVICES' as never)).toBe('Swift doesn\'t allow this item: legal services.');
  });
});

describe('[§8 · R4] a name that IS the goods is refused outright', () => {
  it.each([
    ['Fireworks 10 pack', 'EXPLOSIVES'], ['Squibs', 'EXPLOSIVES'], ['Box of squibs', 'EXPLOSIVES'], ['Firecrackers 20 pack', 'EXPLOSIVES'],
    ['Roman candles 6pk', 'EXPLOSIVES'], ['Gunpowder 1lb', 'EXPLOSIVES'], ['Detonators', 'EXPLOSIVES'], ['Cake sparklers', 'EXPLOSIVES'],
    ['Insecticide 1L', 'PESTICIDES'], ['Weed killer 1L', 'PESTICIDES'], ['Roundup weed killer 1L', 'PESTICIDES'],
    ['Gramoxone 1L', 'PESTICIDES'], ['Paraquat', 'PESTICIDES'], ['Rat poison', 'PESTICIDES'], ['Klerat rat bait', 'PESTICIDES'],
    ['Sodium cyanide', 'PESTICIDES'],
    ['Raw gold', 'PRECIOUS_MINERALS'], ['Gold nuggets', 'PRECIOUS_MINERALS'], ['Uncut diamonds', 'PRECIOUS_MINERALS'],
    ['Rough diamond 2ct', 'PRECIOUS_MINERALS'], ['Precious stones', 'PRECIOUS_MINERALS'], ['Scrap gold', 'PRECIOUS_MINERALS'],
    ['Pistol', 'WEAPONS'], ['Toy pistol', 'WEAPONS'], ['9mm ammo', 'WEAPONS'], ['Air rifle', 'WEAPONS'], ['BB gun', 'WEAPONS'],
    ['Replica gun', 'WEAPONS'], ['Shotgun shells', 'WEAPONS'], ['Taser', 'WEAPONS'], ['Box of ammunition', 'WEAPONS'],
    ['Twa twa', 'WILDLIFE'], ['Seed finch', 'WILDLIFE'], ['Turtle eggs', 'WILDLIFE'], ['Jaguar skin', 'WILDLIFE'],
    ['Counterfeit Rolex', 'COUNTERFEIT'], ['Knockoff handbag', 'COUNTERFEIT'], ['Super copy Nike shoes', 'COUNTERFEIT'],
    ['Banknotes', 'CURRENCY'], ['Foreign currency', 'CURRENCY'], ['Prepaid Visa $100', 'CURRENCY'], ['Visa gift card', 'CURRENCY'],
    ['Prop money', 'CURRENCY'],
    ['Legal consultation (1 hour)', 'LEGAL_SERVICES'], ['Conveyancing', 'LEGAL_SERVICES'], ['Legal services', 'LEGAL_SERVICES'],
    ['Sex doll', 'AGE_RESTRICTED'], ['Adult magazine', 'AGE_RESTRICTED'], ['Slot machine', 'AGE_RESTRICTED'],
  ] as const)('%s → BANNED as %s', (name, cls) => {
    expect(checkItem({ name })).toMatchObject({ state: 'BANNED', prohibitedClass: cls, source: 'word', field: 'name' });
  });

  it('an option that IS the goods refuses the item too', () => {
    expect(checkItem({ name: 'Party pack', optionNames: ['Balloons', 'Box of squibs'] })).toMatchObject({ state: 'BANNED', prohibitedClass: 'EXPLOSIVES', field: 'option' });
    expect(checkItem({ name: 'Garden bundle', optionNames: ['Hose', 'Weed killer 1L'] })).toMatchObject({ state: 'BANNED', prohibitedClass: 'PESTICIDES', field: 'option' });
  });
});

describe('[§8 · R4] a word that only mentions the goods holds the item for a person', () => {
  it.each([
    ['Gun', 'WEAPONS'], ['Air gun', 'WEAPONS'], ['Rifle scope', 'WEAPONS'], ['Pepper spray', 'WEAPONS'], ['Toy gun', 'WEAPONS'],
    ['Parrot', 'WILDLIFE'], ['Macaw (live)', 'WILDLIFE'], ['Sloth plush toy', 'WILDLIFE'],
    ['Gemstone bracelet', 'PRECIOUS_MINERALS'], ['Gold dust 1g', 'PRECIOUS_MINERALS'], ['Gold bar chocolate', 'PRECIOUS_MINERALS'],
    ['Gift card $5000', 'CURRENCY'], ['Credit card', 'CURRENCY'], ['Bitcoin', 'CURRENCY'],
    ['Baygon spray', 'PESTICIDES'], ['Mosquito coils 10pk', 'PESTICIDES'], ['Bug spray', 'PESTICIDES'],
    ['Replica jersey', 'COUNTERFEIT'], ['Bootleg DVD', 'COUNTERFEIT'],
    ['Lawyer', 'LEGAL_SERVICES'], ['Firecracker popsicle', 'EXPLOSIVES'],
    // [REVIEW-F S3-1] held, not refused: a book, craft beads, a word that is also a flavour or a shade
    ['Legal advice', 'LEGAL_SERVICES'], ['Legal advice book', 'LEGAL_SERVICES'], ['First copy signed', 'COUNTERFEIT'],
    ['First copy Nike shoes', 'COUNTERFEIT'], ['Semi precious stones 100g', 'PRECIOUS_MINERALS'], ['Firecrackers', 'EXPLOSIVES'],
    ['Dynamite', 'EXPLOSIVES'], ['Cherry bomb', 'EXPLOSIVES'],
    ['Raffle tickets roll', 'AGE_RESTRICTED'], ['Escort service', 'AGE_RESTRICTED'],
  ] as const)('%s → WAITING (%s)', (name, cls) => {
    expect(checkItem({ name })).toMatchObject({ state: 'WAITING', prohibitedClass: cls });
  });

  it('in a description or a menu section it holds, never refuses', () => {
    expect(checkItem({ name: 'Garden bundle', description: 'Comes with a free weed killer sample' })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES', field: 'description' });
    expect(checkItem({ name: 'Sparkler candle set', sectionName: 'Fireworks & party' })).toMatchObject({ state: 'WAITING', prohibitedClass: 'EXPLOSIVES' });
  });

  it('a store whose own words name the goods is held with its items', () => {
    expect(storeWordHit({ name: 'Agro Chemicals', description: 'Pesticides, fertilisers and seeds' })).toMatchObject({ prohibitedClass: 'PESTICIDES', field: 'description' });
    expect(storeWordHit({ name: 'Gun & Ammo Depot' })).toMatchObject({ prohibitedClass: 'WEAPONS' });
    expect(storeWordHit({ name: 'Bourda Law Firm', tags: ['legal services'] })).toMatchObject({ prohibitedClass: 'LEGAL_SERVICES' });
    expect(storeWordHit({ name: 'Golden Jewellery', description: 'Gold chains, diamond rings and earrings', tags: ['jewellery'] })).toBeNull();
  });
});

describe('[§8 · R4] lottery, gambling and adult goods are caught (18+ class)', () => {
  it.each([
    'Lotto ticket', 'Lottery tickets', 'Casino chips', 'Sports betting slip', 'Scratch off ticket', 'Sex toy', 'Vibrator',
    'Dildo', 'Porn DVD', 'Pornography', 'Adult movies', 'Butt plug', 'Fleshlight',
  ])('%s is the 18+ class', (name) => {
    expect(classifyText(name)).toMatchObject({ prohibitedClass: 'AGE_RESTRICTED' });
    expect(checkItem({ name }).state).not.toBe('CLEAR');
  });
});

describe('[§8 · R4] ordinary goods that share a word stay clear', () => {
  it.each([
    'Glue gun', 'Hot glue gun sticks', 'Nail gun', 'Caulking gun', 'Spray gun', 'Water gun', 'Water pistol', 'Massage gun',
    'Pistol grip', 'Shotgun microphone', 'Gunpowder green tea', 'Gunpowder tea', 'Firecracker shrimp', 'Dynamite shrimp',
    'Parrot fish', 'Parrotfish fillet', 'Gold chain 18k', 'Diamond ring', 'Gold plated earrings', 'Diamond blade 4"',
    'Ink cartridge HP 61', 'Bullet camera', 'Credit card holder', 'Leather credit card wallet', 'Gift card holder',
    'Mercury outboard motor parts', 'Ivory dress', 'Tortoiseshell sunglasses', 'Turtle neck sweater', 'Bath bomb', 'Flare jeans',
    'Monkey bread', 'Monkey wrench', 'Weed eater line', 'Weed control fabric', 'Counterfeit detector pen', 'Bootleg jeans',
    'Power of attorney form', 'Chocolate coins', 'Phone card $1000', 'Digicel scratch card $500', 'Mineral water 500ml',
    'Rocket salad', 'Cream crackers', 'Cherry tomatoes', 'Bottle opener', 'Fake flowers', 'Imitation jewellery', 'Birthday candles',
    'Bullion cubes', 'Lemon pepper seasoning', 'Seaweed snacks',
    // [REVIEW-F S3-1] office, collector and toy goods
    'Banknote counter', 'Bank note counting machine', 'Banknote album', 'Nerf bullets refill 100pcs', 'Gel blaster bullets 10000pcs',
    'Water bullets', 'Ammunition box', 'Ammo can', 'Bauxite',
  ])('%s is clear', (name) => {
    expect(checkItem({ name }), name).toEqual({ state: 'CLEAR' });
  });

  it('a store that takes cards says so without being held', () => {
    expect(storeWordHit({ name: 'Bourda Hardware', description: 'We accept credit cards. Glue guns, nail guns and spray guns in stock.' })).toBeNull();
  });

  // [REVIEW-F S3-2] a store's payment wording is not goods; bauxite is a town's industry, not a listing
  it.each([
    { name: 'Bourda Variety', description: 'We accept US dollars and credit cards.' },
    { name: 'Gift Corner', description: 'Gift cards available' },
    { name: 'Linden Hardware', description: 'Serving Bauxite communities since 1990' },
    { name: 'Corner Shop', tags: ['debit cards accepted', 'gift cards'] },
  ])('store words $description are not held', (store) => {
    expect(storeWordHit(store)).toBeNull();
  });

  it('a store still says what it sells: a cambio or a gun shop is held', () => {
    expect(storeWordHit({ name: 'Cambio Express', description: 'Best rates' })).toMatchObject({ prohibitedClass: 'CURRENCY' });
    expect(storeWordHit({ name: 'Gun & Ammo Depot', description: 'We accept credit cards' })).toMatchObject({ prohibitedClass: 'WEAPONS' });
  });

  // [REVIEW-F S3-1] a one-word shade or flavour option that is also an explosive holds the item, never refuses it
  it.each([
    ['Lip gloss', 'Cherry bomb'], ['Popsicle', 'Firecracker'], ['Hot sauce', 'Dynamite'], ['Energy drink', 'TNT'],
    ['Nail polish', 'Smoke bomb'], ['Candle', 'Sparklers'],
  ])('%s with the option %s is held, not refused', (name, option) => {
    expect(checkItem({ name, optionNames: [option] })).toMatchObject({ state: 'WAITING', prohibitedClass: 'EXPLOSIVES', field: 'option' });
  });

  it('with a pack or another word in front they are the goods again', () => {
    for (const name of ['Sparklers 10 pack', 'Firecrackers 20 pack', 'Cake sparklers']) {
      expect(checkItem({ name }), name).toMatchObject({ state: 'BANNED', prohibitedClass: 'EXPLOSIVES' });
    }
  });
});

describe('[§8 · R4] a parcel naming the goods is refused; legal-services words never refuse a parcel', () => {
  it.each([
    ['Box of squibs', 'EXPLOSIVES'], ['Bottle of paraquat', 'PESTICIDES'], ['Raw gold', 'PRECIOUS_MINERALS'],
    ['9mm ammo', 'WEAPONS'], ['A pair of twa twa birds', 'WILDLIFE'], ['Counterfeit perfume', 'COUNTERFEIT'],
    ['Foreign currency for my aunt', 'CURRENCY'], ['Fireworks for my lawyer', 'EXPLOSIVES'],
  ] as const)('%s → refused (%s)', (text, cls) => {
    expect(parcelProhibited(text)).toMatchObject({ prohibitedClass: cls });
  });

  it.each(['Fruit basket for my lawyer', 'Gift for the attorney at law', 'Legal advice book'])('%s is not refused as a service', (text) => {
    expect(parcelProhibited(text)).toBeNull();
  });

  // [REVIEW-F S3-2] no person reads a parcel: the hold words a person would clear do not refuse it
  it.each([
    'Parrot food for my bird', 'Gemstone bracelet', 'Gold bar chocolate', 'Sloth plush toy', 'Replica jersey',
    'Bug spray and sunscreen', 'Mosquito coils for grandma', 'Crypto hardware wallet', 'Gift card for my niece',
    'Banknote counter for my shop', 'Semi precious stones for beading', 'Wild bird seed 5lb',
  ])('%s is not refused', (text) => {
    expect(parcelProhibited(text)).toBeNull();
  });

  // …but a parcel is still refused for the certain words, and for firearms, payment cards and currency described plainly
  it.each([
    ['Fireworks for the party', 'EXPLOSIVES'], ['Rat poison', 'PESTICIDES'], ['Gold nuggets', 'PRECIOUS_MINERALS'],
    ['Toy gun for my son', 'WEAPONS'], ['Rifle scope', 'WEAPONS'], ['Gun for my cousin', 'WEAPONS'],
    ['Credit card for my son', 'CURRENCY'], ['US dollars for my aunt', 'CURRENCY'], ['Banknotes', 'CURRENCY'],
    ['Shark fin', 'WILDLIFE'], ['Counterfeit perfume', 'COUNTERFEIT'],
  ] as const)('%s → still refused (%s)', (text, cls) => {
    expect(parcelProhibited(text)).toMatchObject({ prohibitedClass: cls });
  });
});

describe('[§8 · R4 · A8] a service profile may not offer legal services', () => {
  it.each([
    ['Carpentry and legal advice', 'legal advice'], ['Legal-Consultation for land deeds', 'legal consultation'],
    ['Conveyancing on request', 'conveyancing'], ['Attorney-at-law and handyman', 'attorney at law'],
    ['L3gal s3rvices', 'legal service'], ['We run a law firm too', 'law firm'],
  ] as const)('%s → offers %s', (bio, term) => {
    expect(offersLegalServices(bio)).toBe(term);
  });

  it.each(['Built-ins and cabinets', 'Ask my brother, a lawyer, about my work', 'Power of attorney forms witnessed', null, ''])('%s → no offer', (bio) => {
    expect(offersLegalServices(bio)).toBeNull();
  });
});
