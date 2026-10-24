/**
 * [GUARDRAILS §8 · owner 16 Oct 2026] Sealed retail HOUSEHOLD insecticide is allowed: aerosol insect sprays, mosquito
 * coils and the household brands on a Guyanese shop shelf (Baygon, Mortein) may be listed without a person's check, and
 * carried in a parcel. Agricultural and garden pesticides stay banned under R4 (Cap. 68:09): the generic and farm words,
 * the active ingredients, weed killers and poisons are judged exactly as before — and a household word never hides them,
 * however they are disguised. A household word written beside farm or garden use, or a size no household buys, is held
 * for a person again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkItem, isHidden, parcelProhibited, storeWordHit, storeWordsNotHousehold } from '../modules/compliance/prohibited-items';

describe('[owner 16 Oct] sealed retail household insecticide is allowed', () => {
  it.each([
    'Baygon spray', 'Baygon Multi-Insect Killer 400ml', 'Baygon insecticide aerosol 300ml', 'Mortein insecticide spray 300ml',
    'Mortein', 'Mosquito coils 10pk', 'Mosquito Coils (10-pack)', 'Bug spray', 'Insect spray 600ml', 'Fly spray',
    'Roach killer spray', 'Ant killer', 'Household insecticide 400ml', 'Aerosol insecticide', 'Insecticide coils 10 pack',
    'Mosquito insecticide spray', 'BAYGON SPRAY', 'Bug sprays (2 pack)',
  ])('%s is clear', (name) => {
    expect(checkItem({ name }), name).toEqual({ state: 'CLEAR' });
  });

  it('as an option, in a description or a menu section, and in a store’s own words', () => {
    expect(checkItem({ name: 'Pest pack', optionNames: ['Baygon 400ml', 'Mosquito coils'] })).toEqual({ state: 'CLEAR' });
    expect(checkItem({ name: 'Summer bundle', description: 'Sunscreen, bug spray and a pack of mosquito coils', sectionName: 'Insect spray & coils' })).toEqual({ state: 'CLEAR' });
    expect(checkItem({ name: 'Grocery bundle', description: 'Rice 5lb, sugar, chicken and a Baygon spray' })).toEqual({ state: 'CLEAR' });
    expect(storeWordHit({ name: 'Corner Shop', description: 'Groceries, Baygon, Mortein and mosquito coils', tags: ['bug spray'] })).toBeNull();
  });

  it.each(['Baygon spray for grandma', 'Mosquito coils and bug spray', 'Mortein 300ml', 'Baygon for the farm house', 'Rice, flour and Baygon'])('the parcel %s is not refused', (text) => {
    expect(parcelProhibited(text)).toBeNull();
  });
});

describe('[owner 16 Oct · R4] agricultural and garden pesticides stay banned; a household word never hides them', () => {
  it.each([
    'Insecticide 1L', 'Insecticides', 'Pesticide 1L', 'Herbicide 5L', 'Fungicide', 'Weed killer spray', 'Roundup weed killer 1L', 'Gramoxone 1L',
    'Paraquat', 'Malathion insecticide spray', 'Cypermethrin bug spray', 'Baygon and rat poison', 'Rat poison', 'Klerat rat bait',
    // disguised: l33t, spaced, look-alike letters and invisible characters
    'P@raquat bug spray', 'Bug spray - Gr@moxone', 'Mosquito coils + w33d k1ller 1L', 'Baygon (p a r a q u a t)',
    'Insect spray w/ m-a-l-a-t-h-i-o-n', 'Ρaraquat insect spray', 'Bug spray par\u200Baquat', 'R4t p0ison - bug spray',
    'Bug spray w/ p-a-r-a-q-u-a-t', 'Bug spray x p.a.r.a.q.u.a.t', 'Spray w/ m-a-l-a-t-h-i-o-n',
  ])('%s is refused (PESTICIDES)', (name) => {
    expect(checkItem({ name }), name).toMatchObject({ state: 'BANNED', prohibitedClass: 'PESTICIDES' });
  });

  it.each([
    // farm, garden or bulk use written beside a household word: a person looks first
    'Baygon farm concentrate', 'Bug spray for crops', 'Insect killer for lawns', 'Mosquito coils - garden pack',
    'Agricultural insecticide aerosol', 'Bug spray 1 gallon', 'Insect spray, commercial strength', 'Fly spray for cattle',
    // a generic insecticide is not a household form by its name alone
    'Insecticide spray', 'Insecticide for mosquitoes',
  ])('%s is held for a person (PESTICIDES)', (name) => {
    expect(checkItem({ name }), name).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
  });

  it('farm use written in another field of the item holds the household word too', () => {
    expect(checkItem({ name: 'Baygon spray', description: 'For the rice fields' })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
    expect(checkItem({ name: 'Mosquito coils', sectionName: 'Agro chemicals' })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
  });

  // A household word used to hold such an item, and the run was found behind it; now the run itself is read where it
  // stands: a stray letter beside it ("w/", "x") is not glued on.
  it.each([['Gift w/ v-o-d-k-a', 'ALCOHOL'], ['Party pack x f.i.r.e.w.o.r.k.s', 'EXPLOSIVES']] as const)('the spelled-out goods in %s are read (%s)', (name, cls) => {
    expect(checkItem({ name })).toMatchObject({ state: 'BANNED', prohibitedClass: cls });
  });

  // A household word used to hold the text for a person, and a name was searched for certain goods behind it. It still
  // is: the household word is allowed, never a cover.
  it('the certain goods behind a household word refuse a name, and hold a description or a store', () => {
    for (const name of ['Baygon w/ x-m', 'Baygon w/ e-l- -d-o-r-a-d-o', 'Mosquito coils / XM 750']) {
      expect(checkItem({ name }), name).toMatchObject({ state: 'BANNED', prohibitedClass: 'ALCOHOL' });
    }
    expect(checkItem({ name: 'Pest pack', description: 'Baygon w/ x-m' })).toMatchObject({ state: 'WAITING', prohibitedClass: 'ALCOHOL', field: 'description' });
    expect(storeWordHit({ name: 'Corner Shop', description: 'Baygon w/ x-m' })).toMatchObject({ prohibitedClass: 'ALCOHOL', field: 'description' });
  });

  it('an active ingredient in a description is held for a person, as before', () => {
    expect(checkItem({ name: 'Bug spray', description: 'Contains cypermethrin' })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES', field: 'description' });
  });

  it('a store that names farm chemicals is still held; so is one that sells Baygon beside garden supplies (fails closed)', () => {
    expect(storeWordHit({ name: 'Agro Supplies', description: 'Pesticides, Baygon and seeds for farms' })).toMatchObject({ prohibitedClass: 'PESTICIDES' });
    expect(storeWordHit({ name: 'Corner Shop', description: 'Mosquito coils and weed killer' })).toMatchObject({ prohibitedClass: 'PESTICIDES' });
    // [#1805 REVIEW-F S2-1] a garden word in the store's own words: its household words are held for a person (as on main)
    expect(storeWordHit({ name: 'Bourda Hardware', description: 'Hardware, garden supplies, Baygon and mosquito coils' })).toMatchObject({ prohibitedClass: 'PESTICIDES' });
    expect(storeWordHit({ name: 'Bourda Hardware', description: 'Hardware, paint, Baygon and mosquito coils' })).toBeNull();
  });

  it.each([
    ['Paraquat in a bug spray can', 'PESTICIDES'], ['Mosquito coils and rat poison', 'PESTICIDES'], ['Baygon + gr@moxone', 'PESTICIDES'],
    ['Bug spray and v0dka', 'ALCOHOL'], ['Mosquito coils, fireworks', 'EXPLOSIVES'],
  ] as const)('the parcel %s is refused (%s)', (text, cls) => {
    expect(parcelProhibited(text)).toMatchObject({ prohibitedClass: cls });
  });
});

describe('[#1805 REVIEW-F S2-1] the household exemption fails closed: only a plain household form, nothing farm or garden', () => {
  // The reviewer's probe: every one of these was held for a person on main and listed with NO person at 5fac3cac.
  it.each([
    'Insect killer for plants', 'Bug spray for vegetables', 'Bug killer for fruit trees', 'Insect spray for flowers', 'Bug spray for the yard',
    'Ant killer for the backyard', 'Insect spray for rice', 'Baygon granules for soil', 'Insect killer for poultry pens', 'Fly spray for the pig pen',
    'Bug spray 5L', 'Insect killer 20 litres', 'Baygon 4 litre', 'Bug spray 200L', 'Bug spray 1 gal', 'Insect killer 5 gal', 'Baygon 2kg',
    // everyday or disguised words this list does not know are not a household form either
    'Baygon spray for grandma', 'Bug spray for pl@nts', 'Mosquito coils for the chicken coop', 'Fly spray for horses', 'Bug spray for the goat pen',
    'Insect killer for seedlings', 'Bug spray 1.5 l', 'Fly spray 1500ml',
  ])('%s is held for a person (PESTICIDES), never listed without one', (name) => {
    const check = checkItem({ name });
    expect(check, name).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
    expect(isHidden(check)).toBe(true);
  });

  it('a plant or animal use written in another of the item’s own fields holds the household word too', () => {
    expect(checkItem({ name: 'Insect killer', description: 'Spray on your plants and vegetables' })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
    expect(checkItem({ name: 'Fly spray', sectionName: 'Livestock care' })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
    expect(checkItem({ name: 'Bug spray', optionNames: ['For the backyard'] })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
  });

  it('an agro, farm or garden supply store holds its own household words and every household word of its items', () => {
    const agro = { name: 'Essequibo Agro Supplies', description: 'Seeds, fertiliser, sprayers and Baygon', tags: ['farm supplies'] };
    expect(storeWordHit(agro)).toMatchObject({ prohibitedClass: 'PESTICIDES' });
    expect(storeWordsNotHousehold(agro)).toBe(true);
    // the supply words in one of the store's fields hold the household words written in another
    expect(storeWordHit({ name: 'Essequibo Agro Supplies', description: 'Baygon and mosquito coils' })).toMatchObject({ prohibitedClass: 'PESTICIDES', field: 'description' });
    expect(storeWordHit({ name: 'Corner Shop', description: 'Baygon and mosquito coils', tags: ['farm supplies'] })).toMatchObject({ prohibitedClass: 'PESTICIDES' });
    expect(checkItem({ name: 'Insect killer', storeNotHousehold: storeWordsNotHousehold(agro) })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
    // a supply store that never names an insecticide in its own words still holds its items' household words
    const quiet = { name: 'Berbice Agro', description: 'Seeds and tools' };
    expect(storeWordHit(quiet)).toBeNull();
    expect(checkItem({ name: 'Mosquito coils 10pk', storeNotHousehold: storeWordsNotHousehold(quiet) })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
    // a platform category of farm or garden goods does the same
    expect(checkItem({ name: 'Bug spray', categories: [{ slug: 'garden-supplies', name: 'Garden supplies' }] })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
    expect(checkItem({ name: 'Bug spray', storeCategories: [{ slug: 'farm-supplies', name: 'Farm supplies' }] })).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
    // a grocery store's words are not read for plant or food words: its Baygon is still allowed
    const grocery = { name: 'Regent Street Grocery', description: 'Fresh vegetables, rice, chicken, Baygon and mosquito coils' };
    expect(storeWordHit(grocery)).toBeNull();
    expect(storeWordsNotHousehold(grocery)).toBe(false);
    expect(checkItem({ name: 'Baygon spray', storeNotHousehold: storeWordsNotHousehold(grocery) })).toEqual({ state: 'CLEAR' });
  });

  it('the catalogue gate hands every item its store’s farm/garden reading (the one place items are judged)', () => {
    const gate = readFileSync(join(__dirname, '..', 'modules', 'compliance', 'prohibited-gate.ts'), 'utf8');
    expect(gate).toContain('storeNotHousehold: storeWordsNotHousehold(item.vendor)');
    expect(gate.match(/checkItem\(\{/g)?.length).toBe(1);
  });

  it('a plain household pack up to 1 litre is still allowed', () => {
    for (const name of ['Mortein 1L', 'Bug spray 600 ml', 'Baygon 1000ml', 'Fly spray (2 x 300ml)', 'Kitchen bug spray', 'Indoor insect spray 400ml']) {
      expect(checkItem({ name }), name).toEqual({ state: 'CLEAR' });
    }
  });

  it('[S4-2] a termite killer is held for a person', () => {
    for (const name of ['Termite killer', 'Termite spray 500ml']) expect(checkItem({ name }), name).toMatchObject({ state: 'WAITING', prohibitedClass: 'PESTICIDES' });
  });
});
