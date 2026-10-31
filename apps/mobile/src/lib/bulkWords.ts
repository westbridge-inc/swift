/**
 * [Owner ruling 31 Oct 2026] The item editor's help under "How bulky is one of these to carry?", one copy for the
 * phone (VendorItemEditorScreen) and the website (dashboard/inventory/menu-tools). What the server does with the choice
 * (apps/api utils/load): a store order is never refused for its size, and an order holding a bulky or very bulky item
 * goes to a motorbike or anything bigger, never to a bicycle (cars on or off).
 */
export type BulkChoiceWord = 'normal' | 'bulky' | 'very_bulky';

export const BULK_WORDS: Record<BulkChoiceWord, string> = {
  normal: 'Fits in a delivery bag with room to spare.',
  bulky: 'Like a crate of drinks or a large box. An order with one is never offered to a rider on a bicycle.',
  very_bulky: 'Like a 20 kg bag of rice or a case of water. An order with one is never offered to a rider on a bicycle.',
};
