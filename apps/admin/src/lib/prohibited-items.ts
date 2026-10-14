import type { ProhibitedClass } from './api';

/** [GUARDRAILS §8] The banned classes in the words a partner reads ("Swift doesn't allow this item: …"). */
export const PROHIBITED_CLASS_LABELS: Record<ProhibitedClass, string> = {
  ALCOHOL: 'alcohol',
  TOBACCO: 'tobacco and cigarettes',
  VAPES: 'vapes',
  MEDICINE: 'medicines',
  AGE_RESTRICTED: '18+ items',
  LPG: 'cooking gas (LPG)',
  FUEL: 'fuel',
};

/** Where in the partner's own text a banned word was found. */
export const JUDGED_FIELD_WORDS: Record<string, string> = {
  name: 'name',
  description: 'description',
  section: 'menu section',
  option: 'options',
  store: 'store\'s own name, description or tags',
};

/** Where in a STORE's own words a banned word was found. [owner 14 Oct, store names] */
export const STORE_FIELD_WORDS: Record<string, string> = {
  name: 'store name',
  description: 'store description',
  tags: 'store tags',
};
