/**
 * [GUARDRAILS §8] Goods Swift never carries — the prohibited-items rule, in code.
 *
 * Owner, 13 Oct 2026, with the law behind it: alcohol, cigarettes and tobacco,
 * vapes, every other 18+ item, ALL medicines (over-the-counter included),
 * cooking gas (LPG) and fuel are banned outright and permanently. There is no
 * switch: nothing in configuration, no licence on file and no reviewer can
 * make them sellable. (The Tobacco Control Act 2017 makes arranging or
 * facilitating a remote tobacco sale, payment or delivery an offence; a
 * druggist's licence is needed even for over-the-counter medicines; LPG and
 * fuel need a GEA licence.)
 *
 * TWO KINDS OF EVIDENCE, TWO ANSWERS (owner, 13 Oct):
 *
 *   · CERTAIN — the item is filed under a banned platform category (Pharmacy,
 *     or any category named for a banned good), or a person removed it as
 *     prohibited. Refused outright: "Swift doesn't allow this item: <what>."
 *
 *   · A WORD — only the partner's own text (name, description, menu section,
 *     options) carries a banned word: "rum cake", "gas stove", "Vicks
 *     VapoRub". The save succeeds, but the item stays HIDDEN — not shown,
 *     searched, carted or ordered — until a person looks at it. The partner
 *     sees "Waiting for a quick check". Approval is bound to the exact words a
 *     person saw (a hash of the judged text), so ANY edit — a rename, a new
 *     option, a move to another section — brings the check back. Approval
 *     never overrides a certain ban.
 *
 * Words are judged whole ("rum" never hits "drumstick", "gin" never hits
 * "ginger"); phrases match whole words in order. This file is the ONE place
 * the word list lives. Prohibited is not the same as the moderation queue:
 * reports (ILLEGAL_GOODS) still reach a person exactly as before.
 */
import { createHash } from 'node:crypto';
import { normalize } from '../discovery/matcher';

export type ProhibitedClass = 'ALCOHOL' | 'TOBACCO' | 'VAPES' | 'MEDICINE' | 'AGE_RESTRICTED' | 'LPG' | 'FUEL';
export type JudgedField = 'name' | 'description' | 'section' | 'option';

export const PROHIBITED_CLASSES: readonly ProhibitedClass[] = ['ALCOHOL', 'TOBACCO', 'VAPES', 'MEDICINE', 'AGE_RESTRICTED', 'LPG', 'FUEL'];

/** Plain words for each class — the end of "Swift doesn't allow this item: …". */
export const PROHIBITED_CLASS_LABELS: Readonly<Record<ProhibitedClass, string>> = {
  ALCOHOL: 'alcohol',
  TOBACCO: 'tobacco and cigarettes',
  VAPES: 'vapes',
  MEDICINE: 'medicines',
  AGE_RESTRICTED: '18+ items',
  LPG: 'cooking gas (LPG)',
  FUEL: 'fuel',
};

/**
 * The word list. Normalized (lowercase, no accents or punctuation — see
 * discovery/matcher `normalize`); plurals listed, nothing stemmed. A word hit
 * only HOLDS an item for a person, so the list leans wide: a false hold costs
 * a reviewer a tap, a missed bottle of rum is the exposure the owner ruled out.
 * Left out because they mean something ordinary far more often than not:
 * scotch (bonnet pepper, tape), spirits (white spirit is paint thinner),
 * cocktail (fruit cocktail), sake (salmon), port, malt and malta (soft drinks),
 * syrup (maple, pancake), tablet (electronics), capsule (coffee), scratch card
 * (phone credit), pills alone (pill box).
 */
export const PROHIBITED_TERMS: Readonly<Record<ProhibitedClass, readonly string[]>> = {
  ALCOHOL: [
    'alcohol', 'alcoholic', 'liquor', 'liquors', 'liqueur', 'liqueurs', 'booze', 'hooch', 'moonshine',
    'beer', 'beers', 'lager', 'lagers', 'ale', 'ales', 'stout', 'stouts', 'ipa', 'pilsner', 'shandy',
    'cider', 'ciders', 'hard seltzer', 'hard lemonade', 'malt liquor', 'spiked', 'boozy', 'radler', 'radlers',
    'spiked seltzer', 'white claw', 'truly seltzer', 'twisted tea', 'truly', 'abv',
    'hard tea', 'hard iced tea', 'hard kombucha', 'hard soda',
    // brands written as one word
    'whiteclaw', 'twistedtea', 'jackdaniels', 'johnniewalker', 'greygoose', 'captainmorgan', 'eldorado', 'mountgay',
    'redstripe', 'budlight',
    'wine', 'wines', 'champagne', 'prosecco', 'sangria', 'vermouth', 'sherry',
    'rum', 'rums', 'high wine', 'puncheon', 'vodka', 'vodkas', 'whisky', 'whiskey', 'whiskies', 'whiskeys', 'bourbon',
    'gin', 'gins', 'brandy', 'brandies', 'cognac', 'tequila', 'mezcal', 'absinthe', 'schnapps', 'soju',
    'mojito', 'martini', 'daiquiri', 'pina colada',
    // brands on Guyanese and Caribbean shelves — phrases where the word alone is ordinary
    'el dorado', 'xm rum', 'xm royal', 'russian bear', 'king of diamonds', 'diamond reserve', 'carib',
    'guinness', 'heineken', 'corona extra', 'mackeson', 'budweiser', 'bud light', 'coors', 'stella artois',
    'red stripe', 'presidente', 'hennessy', 'johnnie walker', 'jack daniel', 'jack daniels', 'jameson', 'smirnoff',
    'bacardi', 'absolut', 'grey goose', 'baileys', 'captain morgan', 'appleton', 'mount gay', 'wray and nephew',
    'chivas', 'glenfiddich', 'jagermeister', 'moet', 'hpnotiq', 'ciroc', 'don julio', 'angostura',
  ],
  TOBACCO: [
    'tobacco', 'cigarette', 'cigarettes', 'cigar', 'cigars', 'cigarillo', 'cigarillos', 'nicotine',
    'rolling paper', 'rolling papers', 'rizla', 'snuff', 'hookah', 'shisha',
    'marlboro', 'benson and hedges', 'benson hedges', 'rothmans', 'du maurier', 'pall mall', 'dunhill', 'lucky strike',
  ],
  VAPES: [
    'vape', 'vapes', 'vaping', 'vaper', 'e cig', 'e cigs', 'ecig', 'ecigs', 'e cigarette', 'e cigarettes',
    'e liquid', 'e liquids', 'eliquid', 'vape juice', 'vape pen', 'vape coil', 'vape coils', 'vape pod', 'vape pods',
    'juul', 'elf bar', 'elfbar', 'geek bar', 'puff bar',
  ],
  MEDICINE: [
    'medicine', 'medicines', 'medication', 'medications', 'medicinal', 'pharmacy', 'pharmaceutical', 'pharmaceuticals',
    'prescription', 'rx', 'otc', 'drug', 'drugs', 'painkiller', 'painkillers', 'pain relief', 'pain reliever', 'analgesic',
    'paracetamol', 'acetaminophen', 'panadol', 'tylenol', 'ibuprofen', 'advil', 'motrin', 'nurofen', 'aspirin', 'disprin',
    'diclofenac', 'naproxen', 'aleve', 'codeine', 'tramadol', 'morphine', 'oxycodone', 'diazepam', 'valium', 'xanax',
    'alprazolam', 'sleeping pills',
    'antibiotic', 'antibiotics', 'amoxicillin', 'penicillin', 'azithromycin', 'ciprofloxacin', 'metronidazole', 'flagyl',
    'antihistamine', 'antihistamines', 'loratadine', 'claritin', 'cetirizine', 'zyrtec', 'benadryl', 'diphenhydramine',
    'piriton', 'chlorpheniramine', 'cough syrup', 'cough mixture', 'cough medicine', 'cold and flu', 'flu tablets',
    'decongestant', 'robitussin', 'buckleys', 'vicks', 'vaporub', 'strepsils', 'throat lozenges', 'lozenge', 'lozenges',
    'cough drop', 'cough drops', 'throat drops', 'nasal spray',
    'eye drops', 'ear drops', 'antacid', 'antacids', 'gaviscon', 'pepto bismol', 'milk of magnesia', 'imodium',
    'loperamide', 'laxative', 'laxatives', 'omeprazole', 'ranitidine', 'metformin', 'insulin', 'inhaler', 'inhalers',
    'salbutamol', 'ventolin', 'prednisone', 'prednisolone', 'steroid', 'steroids', 'hydrocortisone', 'antifungal',
    'clotrimazole', 'canesten', 'calamine', 'gripe water', 'deep heat', 'bengay', 'icy hot', 'liver salts', 'dewormer',
    'deworming', 'mebendazole', 'albendazole', 'chloroquine', 'contraceptive', 'contraceptives', 'morning after pill',
    'postinor', 'viagra', 'sildenafil', 'cialis', 'tadalafil', 'rehydration salts', 'oral rehydration',
  ],
  AGE_RESTRICTED: [
    'lottery', 'lotto', 'lottery ticket', 'lottery tickets', 'betting', 'gambling', 'casino',
    'sex toy', 'sex toys', 'adult toy', 'adult toys', 'vibrator', 'vibrators', 'dildo', 'dildos', 'porn', 'pornographic',
    'erotic', 'adults only', 'xxx',
  ],
  LPG: [
    'lpg', 'gas', 'cooking gas', 'gas cylinder', 'gas cylinders', 'gas bottle', 'gas bottles', 'gas refill', 'gas refills',
    'propane', 'butane', '20lb gas', '25lb gas', '100lb gas',
  ],
  FUEL: [
    'fuel', 'fuels', 'gasoline', 'petrol', 'diesel', 'kerosene', 'paraffin', 'lamp oil', 'avgas', 'jet fuel',
  ],
};

/**
 * Phrases that contain a listed word but name something else entirely. They
 * are cut out before matching; whatever is left is still judged ("ginger beer
 * and rum punch" is still alcohol). Kept short on purpose: a hold is cheap,
 * and the owner's own examples ("beer batter fish", "gas stove") are holds.
 */
export const PROHIBITED_EXEMPT_PHRASES: readonly string[] = [
  'ginger beer', 'ginger beers', 'root beer', 'root beers', 'birch beer', 'ginger ale', 'ginger ales',
  'wine gum', 'wine gums', 'wine colour', 'wine color', 'wine coloured', 'wine colored',
  'rubbing alcohol', 'isopropyl alcohol', 'alcohol swab', 'alcohol swabs', 'alcohol wipe', 'alcohol wipes',
  'alcohol pad', 'alcohol pads', 'alcohol gel', 'alcohol hand', 'alcohol based hand',
  'fuel filter', 'fuel filters', 'fuel pump', 'fuel pumps', 'fuel cap', 'fuel injector', 'fuel injectors',
  'fuel line', 'fuel hose', 'fuel gauge', 'diesel engine', 'diesel jeans', 'diesel watch', 'paraffin wax',
];

/** The order a mixed text reports its classes in. */
const CLASS_ORDER: readonly ProhibitedClass[] = ['ALCOHOL', 'TOBACCO', 'VAPES', 'MEDICINE', 'AGE_RESTRICTED', 'LPG', 'FUEL'];

const hasPhrase = (haystack: string, phrase: string): boolean => ` ${haystack} `.includes(` ${phrase} `);
const EXEMPT_LONGEST_FIRST = [...PROHIBITED_EXEMPT_PHRASES].sort((a, b) => b.length - a.length).map((p) => p.split(' '));

/**
 * A word in front of an exempt phrase that makes it the restricted thing after
 * all: "hard ginger beer", "spiked root beer", "alcoholic ginger ale". Such an
 * occurrence is NOT cut, so the drink is judged by its own word. [DS1100 S2]
 */
const EXEMPTION_BREAKERS: ReadonlySet<string> = new Set(['hard', 'spiked', 'boozy', 'alcoholic', 'alcohol', 'adult', 'adults', 'strong']);

/** The exemptions that name a soft drink. A text that states a strength ("5%", "ABV", "proof",
 *  "vol", "alc") never gets them: a ginger beer with a strength is a drink Swift does not carry.
 *  [DS1103 S2] Other exemptions ("rubbing alcohol 70%") are unaffected. */
const SOFT_DRINK_EXEMPTIONS: ReadonlySet<string> = new Set(['ginger beer', 'ginger beers', 'root beer', 'root beers', 'birch beer', 'ginger ale', 'ginger ales']);
const STATES_A_STRENGTH = /%|\b(abv|proof|alc|vol)\b/i;

function stripExempt(normalized: string, statesStrength: boolean): string {
  let words = normalized.split(' ').filter(Boolean);
  for (const phrase of EXEMPT_LONGEST_FIRST) {
    if (statesStrength && SOFT_DRINK_EXEMPTIONS.has(phrase.join(' '))) continue;
    const kept: string[] = [];
    for (let i = 0; i < words.length;) {
      const here = phrase.every((w, k) => words[i + k] === w);
      if (here && !(i > 0 && EXEMPTION_BREAKERS.has(words[i - 1]!))) { i += phrase.length; continue; }
      kept.push(words[i]!);
      i += 1;
    }
    words = kept;
  }
  return words.join(' ');
}

/** One text → the first banned class and word it carries, or null. */
export function classifyText(text: string | null | undefined): { prohibitedClass: ProhibitedClass; term: string } | null {
  if (!text) return null;
  const judged = stripExempt(normalize(text), STATES_A_STRENGTH.test(text));
  if (!judged) return null;
  for (const prohibitedClass of CLASS_ORDER) {
    for (const term of PROHIBITED_TERMS[prohibitedClass]) {
      if (hasPhrase(judged, term)) return { prohibitedClass, term };
    }
  }
  return null;
}

/** A platform (discovery) category, judged by its immutable slug and its name — never its aliases. */
export function classifyCategory(category: { slug: string; name: string }): { prohibitedClass: ProhibitedClass; term: string } | null {
  return classifyText(`${category.slug.replace(/-/g, ' ')} ${category.name}`);
}

/** The partner's own words about an item — what a word hit is judged on, and what an approval is bound to. */
export interface ItemWords {
  name: string;
  description?: string | null;
  /** The partner's menu section ("Beers & Wines"): their own free text, so a word hit there holds rather than refuses. */
  sectionName?: string | null;
  /** Option-group names and option names ("Add a drink" → "Carib Lager"). */
  optionNames?: ReadonlyArray<string | null | undefined>;
}

export interface CatalogueFacts extends ItemWords {
  /** Platform categories the item is filed under. */
  categories?: ReadonlyArray<{ slug: string; name: string }>;
  /** Set when a person removed the item as prohibited — one way, never undone. */
  prohibitedAt?: Date | null;
  prohibitedClass?: string | null;
  prohibitedReason?: string | null;
  /** The hash of the judged words a person approved, if any. */
  reviewApprovedHash?: string | null;
}

export type CatalogueCheck =
  | { state: 'BANNED'; prohibitedClass: ProhibitedClass; source: 'category' | 'removed'; term: string | null; reason: string | null }
  | { state: 'WAITING' | 'APPROVED'; prohibitedClass: ProhibitedClass; field: JudgedField; term: string }
  | { state: 'CLEAR' };

/** First word hit across the partner's text, in the order a partner reads it. */
export function wordHit(item: ItemWords): { prohibitedClass: ProhibitedClass; field: JudgedField; term: string } | null {
  const fields: Array<[JudgedField, string | null | undefined]> = [
    ['name', item.name],
    ['section', item.sectionName],
    ['description', item.description],
    ...(item.optionNames ?? []).map((n): [JudgedField, string | null | undefined] => ['option', n]),
  ];
  for (const [field, text] of fields) {
    const hit = classifyText(text);
    if (hit) return { ...hit, field };
  }
  return null;
}

/**
 * The fingerprint of the words a person approved. Every judged field, in a
 * fixed order (options sorted), after normalization — so a reword, a new
 * option or a move to another section changes it and the check comes back.
 */
export function judgedWordsHash(item: ItemWords): string {
  const canonical = JSON.stringify([
    normalize(item.name),
    normalize(item.description ?? ''),
    normalize(item.sectionName ?? ''),
    [...(item.optionNames ?? [])].map((n) => normalize(n ?? '')).sort(),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const asClass = (value: string | null | undefined): ProhibitedClass | null =>
  (PROHIBITED_CLASSES as readonly string[]).includes(value ?? '') ? (value as ProhibitedClass) : null;

/** The verdict on one item. Certain bans first; approval only ever answers a word hit. */
export function checkItem(item: CatalogueFacts): CatalogueCheck {
  if (item.prohibitedAt) {
    return { state: 'BANNED', prohibitedClass: asClass(item.prohibitedClass) ?? 'AGE_RESTRICTED', source: 'removed', term: null, reason: item.prohibitedReason ?? null };
  }
  for (const category of item.categories ?? []) {
    const hit = classifyCategory(category);
    if (hit) return { state: 'BANNED', prohibitedClass: hit.prohibitedClass, source: 'category', term: hit.term, reason: null };
  }
  const hit = wordHit(item);
  if (!hit) return { state: 'CLEAR' };
  const approved = item.reviewApprovedHash != null && item.reviewApprovedHash === judgedWordsHash(item);
  return { state: approved ? 'APPROVED' : 'WAITING', ...hit };
}

/** Hidden from every customer surface: banned, or a word hit nobody has approved yet. */
export const isHidden = (check: CatalogueCheck): boolean => check.state === 'BANNED' || check.state === 'WAITING';

/** "Swift doesn't allow this item: alcohol." — the owner's words, exactly. */
export function notAllowedMessage(prohibitedClass: ProhibitedClass): string {
  return `Swift doesn't allow this item: ${PROHIBITED_CLASS_LABELS[prohibitedClass]}.`;
}

/** What the partner reads on an item a word hit is holding. */
export const WAITING_FOR_CHECK = 'Waiting for a quick check';

/** The customer's message when a cart line or an order line is refused. */
export function orderRefusalMessage(itemName: string): string {
  return `${itemName} isn't available on Swift. Remove it from your cart to continue.`;
}

/**
 * The marks `normalize` removes after NFD (Unicode block "Combining Diacritical
 * Marks"). The database pre-filter strips the same marks from the same NFD form,
 * so it reads a column exactly as the classifier reads the text. [DS1100 S2]
 */
export const PROHIBITED_MARKS_PATTERN = '[\u0300-\u036f]+';

/**
 * The words a database pre-filter looks for, after reading each column as the
 * classifier does (NFD, the marks above removed, lowercased, split on every
 * non-letter): a superset of what the word list can match, so the exact
 * judgement above runs only on the rows that could hit. [DS1100 S2/S3]
 *
 * A whole-word phrase hit means each of its words is a whole word of the text,
 * so a phrase needs only ONE of its words here. It contributes nothing when one
 * of its words is already a banned word ("cooking gas" → "gas"); otherwise its
 * least ordinary word ("bud light" → "bud", never "light"), so ordinary goods
 * are not dragged into the exact check by the thousand. Set overlap, not one
 * long regex: a 400-way alternation costs Postgres ~0.2 ms a row.
 */
const ORDINARY_WORDS: ReadonlySet<string> = new Set([
  'after', 'and', 'of', 'the', 'only', 'hard', 'high', 'light', 'red', 'white', 'grey', 'royal', 'extra', 'reserve', 'king',
  'jack', 'captain', 'mount', 'lucky', 'pain', 'cold', 'morning', 'sleeping', 'eye', 'ear', 'deep', 'hot', 'oral', 'milk',
  'water', 'bar', 'tea', 'oil', 'juice', 'pen', 'coil', 'coils', 'pod', 'pods', 'toy', 'toys', 'ticket', 'tickets', 'liver',
  'paper', 'papers', 'throat', 'lemonade', 'mall', 'e',
]);
const SINGLE_WORD_TERMS: ReadonlySet<string> = new Set(CLASS_ORDER.flatMap((c) => PROHIBITED_TERMS[c]).filter((t) => !t.includes(' ')));
const longest = (words: readonly string[]): string => words.reduce((a, b) => (b.length > a.length ? b : a));

export const PROHIBITED_PREFILTER_WORDS: readonly string[] = [...new Set([
  ...SINGLE_WORD_TERMS,
  ...CLASS_ORDER.flatMap((c) => PROHIBITED_TERMS[c]).filter((t) => t.includes(' ')).flatMap((phrase) => {
    const words = phrase.split(' ');
    if (words.some((w) => SINGLE_WORD_TERMS.has(w))) return [];
    const unusual = words.filter((w) => !ORDINARY_WORDS.has(w));
    return [longest(unusual.length ? unusual : words)];
  }),
])].sort();
