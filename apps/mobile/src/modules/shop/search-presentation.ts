import type { PictogramName } from '../../kit/pictograms';

export type SearchVertical = 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

type SearchPresentation = {
  placeholder: string;
  itemSection: string;
  itemGlyph: PictogramName;
};

const BY_VERTICAL: Record<SearchVertical, SearchPresentation> = {
  RESTAURANT: {
    placeholder: 'Restaurants and dishes…',
    itemSection: 'Dishes',
    itemGlyph: 'food',
  },
  SUPERMARKET: {
    placeholder: 'Groceries and products…',
    itemSection: 'Groceries',
    itemGlyph: 'groceries',
  },
  STORE: {
    placeholder: 'Shops and products…',
    itemSection: 'Products',
    itemGlyph: 'shops',
  },
  SERVICE: {
    placeholder: 'Services and providers…',
    itemSection: 'Services',
    itemGlyph: 'services',
  },
};

const ALL: SearchPresentation = {
  placeholder: 'Restaurants, groceries, shops, services…',
  itemSection: 'Items and services',
  itemGlyph: 'shops',
};

export function searchPresentation(type?: string): SearchPresentation {
  return type && type in BY_VERTICAL ? BY_VERTICAL[type as SearchVertical] : ALL;
}
