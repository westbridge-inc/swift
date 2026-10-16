/**
 * [GUARDRAILS §8 · owner 16 Oct 2026] Sealed retail HOUSEHOLD insecticide is allowed: aerosol insect sprays, mosquito
 * coils and the household brands on a Guyanese shop shelf (Baygon, Mortein) may be listed without a person's check, and
 * carried in a parcel. Agricultural and garden pesticides stay banned under R4 (Cap. 68:09): the generic and farm words,
 * the active ingredients, weed killers and poisons are judged exactly as before — and a household word never hides them,
 * however they are disguised. A household word written beside farm or garden use, or a size no household buys, is held
 * for a person again.
 */
import { describe, it, expect } from 'vitest';
import { checkItem, parcelProhibited, storeWordHit } from '../modules/compliance/prohibited-items';

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

  it('a store that names farm chemicals is still held; one that sells Baygon beside garden supplies is not', () => {
    expect(storeWordHit({ name: 'Agro Supplies', description: 'Pesticides, Baygon and seeds for farms' })).toMatchObject({ prohibitedClass: 'PESTICIDES' });
    expect(storeWordHit({ name: 'Corner Shop', description: 'Mosquito coils and weed killer' })).toMatchObject({ prohibitedClass: 'PESTICIDES' });
    expect(storeWordHit({ name: 'Bourda Hardware', description: 'Hardware, garden supplies, Baygon and mosquito coils' })).toBeNull();
  });

  it.each([
    ['Paraquat in a bug spray can', 'PESTICIDES'], ['Mosquito coils and rat poison', 'PESTICIDES'], ['Baygon + gr@moxone', 'PESTICIDES'],
    ['Bug spray and v0dka', 'ALCOHOL'], ['Mosquito coils, fireworks', 'EXPLOSIVES'],
  ] as const)('the parcel %s is refused (%s)', (text, cls) => {
    expect(parcelProhibited(text)).toMatchObject({ prohibitedClass: cls });
  });
});
