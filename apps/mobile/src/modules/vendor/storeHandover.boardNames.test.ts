import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fx = vi.hoisted(() => {
  const token: unknown = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : token });
  return { token };
});
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@swift/ui', () => ({ color: fx.token, space: fx.token }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('../../kit', () => ({ T: 'T' }));
import { BOARD_NAME_WORDS, boardNames } from './storeHandover';
import { BoardNames } from './BoardNames';

// ---------------------------------------------------------------------------
// [STORE-LINK+NAMES · owner 30 Oct 21:47Z] The customer's and the rider's names
// are easy to see at a glance on the store's order board, on every card — not
// only inside the order. What the card may show: the customer's FIRST name
// (the board read sends no other name since COORD 17 Oct) and the assigned
// rider's first name (the name the store checks at the hand-over). Never a
// last name, a phone number or an address — even if a reply carried one.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const full = {
  customer: { id: 'c-1', firstName: '  Ana ', lastName: 'Lastname', phone: '+5926000000' },
  rider: { user: { firstName: 'Devon', lastName: 'Ridername', phone: '+5927000000' }, licensePlate: 'PAB 1234' },
  deliveryAddress: '1 Test Road',
};

describe('[NAMES] the names on a board card', () => {
  it('the customer\'s first name and the rider\'s first name, trimmed', () => {
    expect(boardNames(full)).toEqual({ customer: 'Ana', rider: 'Devon' });
  });
  it('no rider assigned yet: no rider name (never a guess)', () => {
    expect(boardNames({ ...full, rider: null })).toEqual({ customer: 'Ana', rider: null });
    expect(boardNames({ ...full, rider: { user: null } })).toEqual({ customer: 'Ana', rider: null });
  });
  it('a blank, missing or non-text name is left out', () => {
    expect(boardNames({ customer: { firstName: '   ' }, rider: { user: { firstName: 7 } } })).toEqual({ customer: null, rider: null });
    expect(boardNames({})).toEqual({ customer: null, rider: null });
    expect(boardNames(null)).toEqual({ customer: null, rider: null });
    expect(boardNames(undefined)).toEqual({ customer: null, rider: null });
  });
  it('the words: who each name is', () => {
    expect(BOARD_NAME_WORDS.customer('Ana')).toBe('Customer: Ana');
    expect(BOARD_NAME_WORDS.rider('Devon')).toBe('Rider: Devon');
  });
});

type El = { type: unknown; props: { children?: unknown; testID?: string } };
function texts(node: unknown): string[] {
  if (node == null || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node === 'object' && 'props' in node) return texts((node as El).props.children);
  return [];
}

describe('[NAMES] the phone board card line (BoardNames)', () => {
  it('shows "Customer: Ana" and "Rider: Devon" and nothing else from the people', () => {
    const shown = texts(BoardNames({ order: full })).join(' | ');
    expect(shown).toBe('Customer: Ana | Rider: Devon');
    expect(shown).not.toMatch(/Lastname|Ridername|\+592|Test Road|PAB/);
  });
  it('only the customer before a rider is assigned', () => {
    expect(texts(BoardNames({ order: { ...full, rider: null } })).join(' | ')).toBe('Customer: Ana');
  });
  it('nothing at all when the reply carries no name', () => {
    expect(BoardNames({ order: { customer: null, rider: null } })).toBeNull();
  });
  it('the board card renders the line under its time row, for every order', () => {
    const board = read('src/modules/vendor/screens/VendorOps.tsx');
    expect(board).toMatch(/import \{ BoardNames \} from '\.\.\/BoardNames';/);
    expect(board).toMatch(/<BoardNames order=\{order\} \/>/);
  });
});
