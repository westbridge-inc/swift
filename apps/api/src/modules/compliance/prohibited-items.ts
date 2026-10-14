/**
 * [GUARDRAILS §8] Goods Swift never carries — the prohibited-items rule, in code.
 *
 * Owner, 13 Oct 2026, with the law behind it: alcohol, cigarettes and tobacco,
 * vapes, every other 18+ item, ALL medicines (over-the-counter included),
 * cooking gas (LPG) and fuel are banned outright and permanently; so are
 * cannabis and other illegal drugs (§8 "never … illegal or prohibited items").
 * There is no switch: nothing in configuration, no licence on file and no
 * reviewer can make them sellable. (The Tobacco Control Act 2017 makes
 * arranging or facilitating a remote tobacco sale, payment or delivery an
 * offence; a druggist's licence is needed even for over-the-counter medicines;
 * LPG and fuel need a GEA licence.)
 *
 * TWO KINDS OF EVIDENCE, TWO ANSWERS (owner, 13 Oct; #55/#56, 14 Oct):
 *
 *   · CERTAIN — refused outright: "Swift doesn't allow this item: <what>."
 *       – the item is filed under a banned platform category (Pharmacy, or any
 *         category named for a banned good), or its STORE is (#54);
 *       – a person removed it as prohibited;
 *       – its own name, or one of its options, IS the banned goods: a brand
 *         ("Hennessy VS", "Carib Lager", "Panadol"), a product phrase ("rum
 *         essence", "cooking wine", "e-liquid"), or a goods noun heading the
 *         name ("Legacy Rum", "Non-alcoholic beer", "Red wine 750ml",
 *         "Rum - Bristol White"). Anything SOLD as beer, wine or spirits is
 *         never approvable, whatever its strength (#55); cooking wine, rum
 *         essence and bitters are alcohol (#56).
 *
 *   · A WORD — the partner's own text mentions a banned word without being the
 *     goods: "rum cake", "beer batter fish", "gas stove", a "Beers & Wines"
 *     section, a description. The save succeeds, but the item stays HIDDEN —
 *     not shown, searched, carted or ordered — until a person looks at it. The
 *     partner sees "Waiting for a quick check". Approval is bound to the exact
 *     words a person saw (a hash of the judged text), so ANY edit — a rename, a
 *     new option, a move to another section — brings the check back. Lozenges
 *     are held this way, never refused (#58).
 *
 * Words are judged whole ("rum" never hits "drumstick", "gin" never hits
 * "ginger"); phrases match whole words in order. A text is read through its
 * disguises first: compatibility forms (fullwidth "Ｒｕｍ"), invisible format
 * characters ("R\u200Bum"), Cyrillic and Greek look-alikes ("Rцm") and
 * spelled-out letters ("R.U.M"). This file is the ONE place the word list
 * lives. Prohibited is not the same as the moderation queue: reports
 * (ILLEGAL_GOODS) still reach a person exactly as before.
 */
import { createHash } from 'node:crypto';
import { normalize } from '../discovery/matcher';

export type ProhibitedClass = 'ALCOHOL' | 'TOBACCO' | 'VAPES' | 'DRUGS' | 'MEDICINE' | 'AGE_RESTRICTED' | 'LPG' | 'FUEL';
export type JudgedField = 'name' | 'description' | 'section' | 'option';

export const PROHIBITED_CLASSES: readonly ProhibitedClass[] = ['ALCOHOL', 'TOBACCO', 'VAPES', 'DRUGS', 'MEDICINE', 'AGE_RESTRICTED', 'LPG', 'FUEL'];

/** Plain words for each class — the end of "Swift doesn't allow this item: …". */
export const PROHIBITED_CLASS_LABELS: Readonly<Record<ProhibitedClass, string>> = {
  ALCOHOL: 'alcohol',
  TOBACCO: 'tobacco and cigarettes',
  VAPES: 'vapes',
  DRUGS: 'cannabis and illegal drugs',
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
 * (phone credit), pills alone (pill box), rose (the flower — the wine is
 * "rosé", read as "rosewine"), hemp (seeds and oil are food).
 */
export const PROHIBITED_TERMS: Readonly<Record<ProhibitedClass, readonly string[]>> = {
  ALCOHOL: [
    'alcohol', 'alcoholic', 'liquor', 'liquors', 'liqueur', 'liqueurs', 'booze', 'hooch', 'moonshine',
    'beer', 'beers', 'lager', 'lagers', 'ale', 'ales', 'stout', 'stouts', 'ipa', 'pilsner', 'shandy',
    'cider', 'ciders', 'hard cider', 'hard seltzer', 'hard lemonade', 'malt liquor', 'spiked', 'boozy', 'radler', 'radlers',
    'spiked seltzer', 'white claw', 'truly seltzer', 'twisted tea', 'abv',
    'hard tea', 'hard iced tea', 'hard kombucha', 'hard soda',
    // brands written as one word
    'whiteclaw', 'twistedtea', 'jackdaniels', 'johnniewalker', 'greygoose', 'captainmorgan', 'eldorado', 'mountgay',
    'redstripe', 'budlight',
    'wine', 'wines', 'champagne', 'prosecco', 'sangria', 'vermouth', 'sherry', 'rosewine', 'rosewines', 'madeira', 'marsala',
    'chardonnay', 'merlot', 'cabernet', 'sauvignon', 'pinot', 'shiraz', 'syrah', 'malbec', 'zinfandel', 'riesling',
    'moscato', 'lambrusco', 'chianti',
    'rum', 'rums', 'rhum', 'high wine', 'puncheon', 'vodka', 'vodkas', 'whisky', 'whiskey', 'whiskies', 'whiskeys', 'bourbon',
    'gin', 'gins', 'brandy', 'brandies', 'cognac', 'tequila', 'mezcal', 'absinthe', 'schnapps', 'soju', 'bitters',
    'mojito', 'martini', 'daiquiri', 'pina colada', 'amaretto', 'limoncello', 'pisco', 'pisco sour', 'dubonnet', 'cinzano',
    // [#56] cooking alcohol, and drinks sold ready-mixed
    'rum essence', 'rum extract', 'rum flavouring', 'rum flavoring', 'rum punch', 'rum cream', 'rum and coke', 'gin and tonic',
    // brands on Guyanese and Caribbean shelves — phrases where the word alone is ordinary
    'el dorado', 'xm rum', 'xm royal', 'russian bear', 'king of diamonds', 'diamond reserve', 'carib',
    'guinness', 'heineken', 'corona extra', 'mackeson', 'budweiser', 'bud light', 'coors', 'stella artois',
    'red stripe', 'presidente', 'hennessy', 'johnnie walker', 'johnny walker', 'jack daniel', 'jack daniels', 'jameson', 'smirnoff',
    'bacardi', 'absolut', 'grey goose', 'baileys', 'captain morgan', 'appleton', 'mount gay', 'wray and nephew',
    'chivas', 'glenfiddich', 'jagermeister', 'moet', 'hpnotiq', 'ciroc', 'don julio', 'angostura',
    'barbancourt', 'old parr', 'courvoisier', 'remy martin', 'kahlua', 'seagrams', 'black and white scotch', 'jose cuervo',
    'tanqueray', 'bombay sapphire', 'ballantines', 'famous grouse', 'glenlivet', 'jim beam', 'crown royal', 'campari',
    'aperol', 'martell', 'veuve clicquot', 'dom perignon', 'modelo', 'skol', 'becks', 'peroni', 'amstel', 'carlsberg',
    'kronenbourg', 'miller lite', 'michelob', 'pabst', 'hoegaarden', 'desperados',
    // after the brands, so "Bailey's Irish Cream" reads as Baileys
    'irish cream',
    // [DS1110] more spirits and wines sold as such; ready-mixed drinks; more beer and spirit brands
    'grappa', 'sambuca', 'ouzo', 'cachaca', 'advocaat', 'pastis', 'vodka cruiser', 'vodka cruisers', 'wine cooler', 'wine coolers',
    'four loko', 'havana club', 'sailor jerry', 'disaronno', 'cointreau', 'grand marnier', 'midori', 'cruzan', 'svedka',
    'stolichnaya', 'ketel one', 'dewars', 'olmeca', 'sauza', 'casamigos', 'tsingtao', 'hairoun', 'medalla', 'kalik', 'wadadli',
    // [evasion] the same goods in Spanish, Portuguese, French, German and Italian
    'cerveza', 'cervezas', 'cerveja', 'cervejas', 'biere', 'bieres', 'bier', 'birra', 'vino', 'vinos', 'vinho', 'aguardiente',
    // [DS1111] high-volume names the third review found
    'southern comfort', 'drambuie', 'kubuli',
  ],
  TOBACCO: [
    'tobacco', 'cigarette', 'cigarettes', 'cig', 'cigs', 'cigar', 'cigars', 'cigarillo', 'cigarillos', 'nicotine',
    'rolling paper', 'rolling papers', 'rizla', 'snuff', 'hookah', 'hooka', 'shisha', 'sheesha', 'grabba',
    'marlboro', 'benson and hedges', 'benson hedges', 'rothmans', 'du maurier', 'pall mall', 'dunhill', 'lucky strike',
    'black and mild', 'swisher', 'swisher sweets', 'backwoods', 'craven a', 'al fakher', 'zyn',
    'snus', 'heets', 'iqos', 'captain black', 'golden virginia', 'amber leaf',
    'djarum', 'gudang garam', 'sampoerna', 'mild seven',
    'tabaco', 'cigarro', 'cigarros', 'cigarrillo', 'cigarrillos', 'lambert and butler',
  ],
  VAPES: [
    'vape', 'vapes', 'vaping', 'vaper', 'e cig', 'e cigs', 'ecig', 'ecigs', 'e cigarette', 'e cigarettes',
    'e liquid', 'e liquids', 'eliquid', 'vape juice', 'vape pen', 'vape coil', 'vape coils', 'vape pod', 'vape pods',
    'juul', 'elf bar', 'elfbar', 'geek bar', 'puff bar', 'lost mary', 'smok', 'dab pen', 'vaporizer', 'vaporiser', 'vuse', 'relx', 'njoy', 'uwell', 'caliburn', 'voopoo',
  ],
  DRUGS: [
    'ganja', 'marijuana', 'marihuana', 'cannabis', 'kush', 'weed', 'cbd', 'thc', 'bong', 'bongs', 'pre roll', 'pre rolls', 'preroll', 'prerolls',
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
    'cough drop', 'cough drops', 'throat drops', 'nasal spray', 'fishermans friend',
    'eye drops', 'ear drops', 'antacid', 'antacids', 'gaviscon', 'pepto bismol', 'pepto', 'milk of magnesia', 'imodium',
    'loperamide', 'laxative', 'laxatives', 'omeprazole', 'ranitidine', 'metformin', 'insulin', 'inhaler', 'inhalers',
    'salbutamol', 'ventolin', 'prednisone', 'prednisolone', 'steroid', 'steroids', 'hydrocortisone', 'antifungal',
    'clotrimazole', 'canesten', 'calamine', 'gripe water', 'deep heat', 'bengay', 'icy hot', 'liver salts', 'dewormer',
    'deworming', 'mebendazole', 'albendazole', 'chloroquine', 'contraceptive', 'contraceptives', 'morning after pill',
    'postinor', 'viagra', 'sildenafil', 'cialis', 'tadalafil', 'rehydration salts', 'oral rehydration',
    'benylin', 'nyquil', 'dayquil', 'alka seltzer', 'sudafed', 'theraflu', 'excedrin', 'voltaren', 'buscopan', 'tums', 'eno',
    'cataflam', 'ponstan', 'brufen', 'mucinex', 'neosporin', 'tiger balm', 'headache tablets', 'headache pills',
    'headache relief', 'fever reducer', 'cough and cold', 'augmentin', 'coartem', 'otrivin',
  ],
  AGE_RESTRICTED: [
    'lottery', 'lotto', 'lottery ticket', 'lottery tickets', 'betting', 'gambling', 'casino',
    'sex toy', 'sex toys', 'adult toy', 'adult toys', 'vibrator', 'vibrators', 'dildo', 'dildos', 'porn', 'pornographic',
    'erotic', 'adults only', 'xxx',
  ],
  LPG: [
    'lpg', 'gas', 'cooking gas', 'gas cylinder', 'gas cylinders', 'gas bottle', 'gas bottles', 'gas refill', 'gas refills',
    'propane', 'butane', '20lb gas', '25lb gas', '100lb gas', 'lp gas', 'lp refill', 'lp cylinder', 'cylinder refill',
    '20lb cylinder', '25lb cylinder', '100lb cylinder',
  ],
  FUEL: [
    'fuel', 'fuels', 'gasoline', 'petrol', 'diesel', 'kerosene', 'kero', 'kero oil', 'paraffin', 'lamp oil', 'avgas', 'jet fuel',
    'lighter fluid', 'methylated spirit', 'methylated spirits',
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
  // [DS1105] a grocery staple, not a drink
  'cider vinegar', 'cider vinegars',
  // [launch] soft drinks and mocktails named after a drink; paper and garden goods named after a brand or a word
  'kola champagne', 'cola champagne', 'champagne kola', 'champagne cola',
  'virgin mojito', 'virgin mojitos', 'virgin pina colada', 'virgin colada', 'virgin daiquiri',
  'bristol board', 'bristol boards', 'bristol paper',
  // [DS1109] a non-alcoholic malt; empty fuel containers are hardware
  'malta guinness', 'guinness malta', 'gas can', 'gas cans', 'fuel can', 'fuel cans', 'jerry can', 'jerry cans',
  'weed killer', 'weed killers', 'weed eater', 'weed eaters', 'weed whacker', 'weed wacker', 'weed trimmer',
  'weed control', 'weed spray', 'weed barrier', 'weed preventer', 'weed puller', 'weed and feed', 'weed block',
];

/**
 * Brand words that are ordinary English in prose ("a truly Guyanese
 * breakfast", "river banks", "a tiger"): they count only as the FIRST word of
 * an item's name or of an option ("Truly Pineapple", "Banks 6 pack"), never in
 * a description or a section. [DS1103 S2 brand; DS1104/DS1105 false holds;
 * Opus S1-LAUNCH-1] Most only HOLD the item for a person — "Bud vase",
 * "Tiger prawns", "Halls" (a lozenge, #58). XM is Banks DIH's rum and nothing
 * else on a Guyanese shelf, so it is certain.
 */
const BRAND_FIRST: Readonly<Record<string, { prohibitedClass: ProhibitedClass; certain: boolean; measure?: 'any' | 'liquid' | 'tobacco' | 'none' }>> = {
  truly: { prohibitedClass: 'ALCOHOL', certain: false },
  xm: { prohibitedClass: 'ALCOHOL', certain: true },
  banks: { prohibitedClass: 'ALCOHOL', certain: false },
  stag: { prohibitedClass: 'ALCOHOL', certain: false },
  bud: { prohibitedClass: 'ALCOHOL', certain: false },
  corona: { prohibitedClass: 'ALCOHOL', certain: false },
  tiger: { prohibitedClass: 'ALCOHOL', certain: false },
  malibu: { prohibitedClass: 'ALCOHOL', certain: false },
  camel: { prohibitedClass: 'TOBACCO', certain: false },
  bristol: { prohibitedClass: 'TOBACCO', certain: false },
  halls: { prohibitedClass: 'MEDICINE', certain: false, measure: 'none' },
  bayer: { prohibitedClass: 'MEDICINE', certain: false },
  // [DS1109] Stella (Artois), Velo (nicotine pouches), B&H (read "b h" → "bh")
  stella: { prohibitedClass: 'ALCOHOL', certain: false },
  velo: { prohibitedClass: 'TOBACCO', certain: false },
  bh: { prohibitedClass: 'TOBACCO', certain: false },
  // [DS1110] Mead (also notebooks), Ricard (also a surname), Newport, Kool, Winston (also places and words)
  mead: { prohibitedClass: 'ALCOHOL', certain: false },
  ricard: { prohibitedClass: 'ALCOHOL', certain: false },
  newport: { prohibitedClass: 'TOBACCO', certain: false },
  kool: { prohibitedClass: 'TOBACCO', certain: false },
  winston: { prohibitedClass: 'TOBACCO', certain: false },
  // [evasion] "ron" is Spanish for rum (and a first name)
  ron: { prohibitedClass: 'ALCOHOL', certain: false },
  // [DS1111] Any measure makes a brand-first word the goods (coordinator, 14 Oct: "a brand with ANY measure is
  // refused"), except three words that name an everyday product as often: Bounty (paper towels, chocolate) and Fireball
  // (candy) need a liquid's measure; Davidoff (a fragrance) a cigarette pack. Halls is never refused (#58 lozenges).
  fireball: { prohibitedClass: 'ALCOHOL', certain: false, measure: 'liquid' },
  patron: { prohibitedClass: 'ALCOHOL', certain: false },
  beefeater: { prohibitedClass: 'ALCOHOL', certain: false },
  bounty: { prohibitedClass: 'ALCOHOL', certain: false, measure: 'liquid' },
  piton: { prohibitedClass: 'ALCOHOL', certain: false },
  davidoff: { prohibitedClass: 'TOBACCO', certain: false, measure: 'tobacco' },
};
export const PROHIBITED_BRAND_FIRST_WORDS: readonly string[] = Object.keys(BRAND_FIRST);

/**
 * NEVER APPROVABLE wherever they appear in an item's name or one of its
 * options: brands, wine grapes, branded and generic medicines (not lozenges —
 * #58 holds them), ready-mixed drinks, cooking alcohol (#56) and cannabis.
 * The name or option IS the goods. [Opus S1-LAUNCH-2; #55/#56]
 */
export const PROHIBITED_NEVER_APPROVABLE: readonly string[] = [
  // alcohol: brands, grapes, product phrases
  'whiteclaw', 'twistedtea', 'jackdaniels', 'johnniewalker', 'greygoose', 'captainmorgan', 'eldorado', 'mountgay', 'redstripe', 'budlight',
  'hard seltzer', 'hard lemonade', 'malt liquor', 'spiked seltzer', 'white claw', 'truly seltzer', 'twisted tea',
  'hard tea', 'hard iced tea', 'hard kombucha', 'hard soda', 'high wine',
  'chardonnay', 'merlot', 'cabernet', 'sauvignon', 'pinot', 'shiraz', 'syrah', 'malbec', 'zinfandel', 'riesling', 'moscato', 'lambrusco', 'chianti',
  'rum essence', 'rum extract', 'rum flavouring', 'rum flavoring', 'rum punch', 'rum cream', 'rum and coke', 'gin and tonic',
  'el dorado', 'xm rum', 'xm royal', 'russian bear', 'king of diamonds', 'diamond reserve', 'carib',
  'guinness', 'heineken', 'corona extra', 'mackeson', 'budweiser', 'bud light', 'coors', 'stella artois',
  'red stripe', 'presidente', 'hennessy', 'johnnie walker', 'johnny walker', 'jack daniel', 'jack daniels', 'jameson', 'smirnoff',
  'bacardi', 'absolut', 'grey goose', 'baileys', 'captain morgan', 'appleton', 'mount gay', 'wray and nephew',
  'chivas', 'glenfiddich', 'jagermeister', 'moet', 'hpnotiq', 'ciroc', 'don julio', 'angostura',
  'barbancourt', 'old parr', 'courvoisier', 'remy martin', 'kahlua', 'seagrams', 'black and white scotch', 'jose cuervo',
  'tanqueray', 'bombay sapphire', 'ballantines', 'famous grouse', 'glenlivet', 'jim beam', 'crown royal', 'campari',
  'aperol', 'martell', 'veuve clicquot', 'dom perignon', 'modelo', 'skol', 'becks', 'peroni', 'amstel', 'carlsberg',
  'kronenbourg', 'miller lite', 'michelob', 'pabst', 'hoegaarden', 'desperados',
  'hard cider', 'pisco sour', 'dubonnet', 'cinzano',
  'vodka cruiser', 'vodka cruisers', 'four loko', 'havana club', 'sailor jerry', 'disaronno', 'cointreau', 'grand marnier', 'midori',
  'cruzan', 'svedka', 'stolichnaya', 'ketel one', 'dewars', 'olmeca', 'sauza', 'casamigos', 'tsingtao', 'hairoun', 'medalla',
  'kalik', 'wadadli', 'southern comfort', 'drambuie', 'kubuli', 'lambert and butler', 'uwell', 'caliburn', 'voopoo',
  'augmentin', 'coartem', 'otrivin',
  // tobacco and vapes: brands and the products themselves
  'snus', 'heets', 'iqos', 'captain black', 'golden virginia', 'amber leaf', 'djarum', 'gudang garam', 'sampoerna', 'mild seven',
  'vuse', 'relx', 'njoy',
  'marlboro', 'benson and hedges', 'benson hedges', 'rothmans', 'du maurier', 'pall mall', 'dunhill', 'lucky strike',
  'black and mild', 'swisher', 'swisher sweets', 'backwoods', 'craven a', 'al fakher', 'zyn', 'rizla',
  'juul', 'elf bar', 'elfbar', 'geek bar', 'puff bar', 'lost mary', 'smok', 'dab pen',
  'e cig', 'e cigs', 'ecig', 'ecigs', 'e cigarette', 'e cigarettes', 'e liquid', 'e liquids', 'eliquid',
  'vape juice', 'vape pen', 'vape coil', 'vape coils', 'vape pod', 'vape pods',
  // cannabis — an edible IS the drug, so no dish rescues these
  'ganja', 'marijuana', 'marihuana', 'cannabis', 'kush', 'thc', 'cbd', 'pre roll', 'pre rolls', 'preroll', 'prerolls',
  // medicines by name (lozenges are held, #58)
  'paracetamol', 'acetaminophen', 'panadol', 'tylenol', 'ibuprofen', 'advil', 'motrin', 'nurofen', 'aspirin', 'disprin',
  'diclofenac', 'naproxen', 'aleve', 'codeine', 'tramadol', 'morphine', 'oxycodone', 'diazepam', 'valium', 'xanax', 'alprazolam',
  'amoxicillin', 'penicillin', 'azithromycin', 'ciprofloxacin', 'metronidazole', 'flagyl', 'loratadine', 'claritin',
  'cetirizine', 'zyrtec', 'benadryl', 'diphenhydramine', 'piriton', 'chlorpheniramine', 'robitussin', 'buckleys', 'vaporub',
  'gaviscon', 'pepto bismol', 'pepto', 'imodium', 'loperamide', 'omeprazole', 'ranitidine', 'metformin', 'salbutamol', 'ventolin',
  'prednisone', 'prednisolone', 'hydrocortisone', 'clotrimazole', 'canesten', 'mebendazole', 'albendazole', 'chloroquine',
  'postinor', 'viagra', 'sildenafil', 'cialis', 'tadalafil', 'benylin', 'nyquil', 'dayquil', 'alka seltzer', 'sudafed',
  'theraflu', 'excedrin', 'voltaren', 'buscopan', 'tums', 'eno', 'cataflam', 'ponstan', 'brufen', 'mucinex',
  'cough syrup', 'cough mixture', 'cough medicine', 'cold and flu', 'flu tablets', 'sleeping pills', 'morning after pill',
  'headache tablets', 'headache pills', 'fever reducer', 'cough and cold', 'gripe water', 'deep heat', 'bengay', 'icy hot',
  'liver salts', 'milk of magnesia', 'tiger balm',
  // (No gas or fuel word is here: hardware stores sell "LPG regulators", "gas stoves" and "fuel cans" — held for a person.)
];
const NEVER_APPROVABLE: ReadonlySet<string> = new Set(PROHIBITED_NEVER_APPROVABLE);

/**
 * Goods nouns: never approvable when they HEAD the item's name, an option, or
 * a part of either set off by a comma or a dash — after any size, pack,
 * strength or style words that follow ("Legacy Rum", "Red Wine 750ml", "Beer,
 * alcohol free", "Rum - Bristol White", "Cigarettes 20s"). Elsewhere they only
 * hold the item: "Rum cake", "Wine glass set", "Cigarette lighter". [#55]
 */
export const PROHIBITED_GOODS_NOUNS: readonly string[] = [
  'liquor', 'liquors', 'liqueur', 'liqueurs', 'booze', 'hooch', 'moonshine', 'beer', 'beers', 'lager', 'lagers', 'ale', 'ales',
  'stout', 'stouts', 'ipa', 'pilsner', 'shandy', 'radler', 'radlers', 'wine', 'wines', 'champagne', 'prosecco', 'sangria',
  'vermouth', 'sherry', 'rosewine', 'rum', 'rums', 'rhum', 'vodka', 'vodkas', 'whisky', 'whiskey', 'whiskies', 'whiskeys',
  'bourbon', 'gin', 'gins', 'brandy', 'brandies', 'cognac', 'tequila', 'mezcal', 'absinthe', 'schnapps', 'soju', 'mojito',
  'martini', 'daiquiri', 'pina colada', 'bitters', 'puncheon',
  'tobacco', 'cigarette', 'cigarettes', 'cig', 'cigs', 'cigar', 'cigars', 'cigarillo', 'cigarillos', 'snuff', 'shisha',
  'sheesha', 'hookah', 'hooka', 'grabba', 'rolling paper', 'rolling papers',
  'vape', 'vapes',
  // [DS1109 S3-1] medicines, cooking gas, fuel and paraphernalia sold as such
  'medicine', 'medicines', 'medication', 'medications', 'painkiller', 'painkillers', 'antibiotic', 'antibiotics', 'antacid',
  'antacids', 'antihistamine', 'antihistamines', 'laxative', 'laxatives', 'decongestant', 'insulin', 'inhaler', 'inhalers',
  'dewormer', 'contraceptive', 'contraceptives',
  'lpg', 'gas', 'cooking gas', 'gas cylinder', 'gas cylinders', 'gas bottle', 'gas bottles', 'gas refill', 'gas refills', 'propane',
  'butane', 'lp gas', 'lp refill', 'lp cylinder', 'cylinder refill', '20lb cylinder', '25lb cylinder', '100lb cylinder',
  '20lb gas', '25lb gas', '100lb gas',
  'fuel', 'fuels', 'gasoline', 'petrol', 'diesel', 'kerosene', 'kero', 'kero oil', 'paraffin', 'lamp oil', 'avgas', 'jet fuel',
  'lighter fluid', 'methylated spirit', 'methylated spirits',
  'bong', 'bongs',
  // [DS1110] spirits sold as such; medicines named by their form; cannabis by the gram; 18+ goods
  'grappa', 'sambuca', 'ouzo', 'cachaca', 'advocaat', 'pastis', 'eye drops', 'ear drops', 'nasal spray', 'weed',
  'lottery ticket', 'lottery tickets', 'sex toy', 'sex toys', 'adult toy', 'adult toys', 'vibrator', 'vibrators',
  'dildo', 'dildos', 'wine coolers',
  'cerveza', 'cervezas', 'cerveja', 'cervejas', 'biere', 'bieres', 'bier', 'birra', 'vino', 'vinos', 'vinho', 'aguardiente',
  'tabaco', 'cigarro', 'cigarros', 'cigarrillo', 'cigarrillos',
  // [DS1109] sold with a size only ("Marsala 750ml"; "Chicken Marsala" and "Madeira cake" are dishes) — see SIZED_ONLY
  'rosewines', 'cider', 'ciders', 'madeira', 'marsala', 'amaretto', 'limoncello', 'pisco', 'irish cream',
];
/** Goods nouns that are also a colour or a cut ("Dress — Wine", "Heels - Champagne", a "Stout" fit): certain only with
 *  another word in front ("Red wine", "House wine") or a size after ("Wine 750ml"); alone they hold. */
const AMBIGUOUS_ALONE: ReadonlySet<string> = new Set(['wine', 'wines', 'champagne', 'cognac', 'stout', 'stouts', 'sherry', 'brandy', 'bourbon', 'rosewine', 'rosewines', 'vino', 'vinos', 'vinho']);
/** Goods nouns that name a dish or a flavour as often as the drink ("Chicken Marsala", "Madeira cake", "Amaretto
 *  biscotti", "Irish cream coffee creamer", sparkling apple cider): certain only with a drink measure after them. [DS1109] */
const SIZED_ONLY: ReadonlySet<string> = new Set(['cider', 'ciders', 'madeira', 'marsala', 'amaretto', 'limoncello', 'pisco', 'irish cream', 'wine coolers']);
/** Certain only as the whole name: "Vibrator" is the 18+ good; a "Concrete vibrator" is a building tool. [DS1110] */
const ALONE_ONLY: ReadonlySet<string> = new Set(['vibrator', 'vibrators']);
/** Cannabis is sold by the gram or the ounce ("Weed 3.5g"); a "weed killer" is not. [DS1110 S3-2] */
const GRAMS_ONLY: ReadonlySet<string> = new Set(['weed']);
const CANNABIS_MEASURE = /^(\d+(g|gram|grams|oz)|g|gram|grams|oz|ounce|ounces|eighth|quarter|joint|joints|blunt|blunts|spliff|spliffs)$/;
/** An age statement ("12 year old", "5 yr", "7 años"): a spirit's measure as surely as its volume. [regression guard] */
const AGE_STATEMENT = /^(year|years|yr|yrs|yo|anos|ano|\d+(yr|yrs|yo|y))$/;
/** A liquid's own measure, and a cigarette or pouch pack's: what makes a brand-first word the goods for a brand that
 *  also names other things. [DS1111] */
const LIQUID_MEASURE = /^(\d+(ml|cl|dl|l|lt|ltr|ltrs|oz|floz)|ml|cl|dl|l|lt|ltr|ltrs|litre|litres|liter|liters|oz|floz|bottle|bottles|btl|nip|nips|pint|pints|magnum|flask|flasks)$/;
const TOBACCO_MEASURE = /^(\d+s|\d+(pk|pack)|pk|pack|packs|carton|cartons|pouch|pouches)$/;
/** A medicine's own measure: its pills and its dose ("Bayer 30 tabs", "Bayer 325mg", "Bayer 81 mg"). Not "caps" (hats)
 *  nor a spray or a cream (Bayer also makes crop sprays). [regression guard] */
const PILL_MEASURE = /^(\d*(tab|tabs|tablet|tablets|capsule|capsules|caplet|caplets|mg|mcg|iu))$/;
/** The form a medicine is sold in, after its name ("Insulin 100 units", "Antibiotic cream 30g", "Insulin pen"). [DS1110 S3-1] */
const MEDICINE_FORMS: ReadonlySet<string> = new Set([
  'cream', 'creams', 'ointment', 'ointments', 'gel', 'gels', 'drops', 'spray', 'sprays', 'syrup', 'syrups', 'tablet', 'tablets',
  'tab', 'tabs', 'capsule', 'capsules', 'caplet', 'caplets', 'pen', 'pens', 'injection', 'injections', 'vial', 'vials', 'unit',
  'units', 'iu', 'dose', 'doses', 'suspension', 'solution', 'sachet', 'sachets', 'mg', 'mcg',
]);
/**
 * A drink, tobacco or pouch MEASURE ("750ml", "12oz", "6 pack", "20s", "a case"): what makes "Banks 6 pack" beer and
 * "Wine 750ml" wine. A bare number does not ("Wine 8", "Stout 42" are shoe sizes), nor grams ("Tiger prawns 500g"). [DS1109 S2-2, S4-2]
 */
const DRINK_MEASURE = /^(\d+(ml|cl|dl|l|lt|ltr|ltrs|oz|floz|pk|pack|packs|s|ct)|ml|cl|l|lt|ltr|ltrs|litre|litres|liter|liters|oz|floz|pk|pack|packs|case|cases|carton|cartons|crate|crates|bottle|bottles|btl|can|cans|nip|nips|pint|pints|magnum|flask|flasks|pouch|pouches)$/;
/**
 * A dish or a flavour: an alcohol BRAND in front of one names the dish, not the drink ("Hennessy wings", "Jack Daniels
 * BBQ sauce", "Baileys ice cream", "Campari tomatoes") — held for a person, never refused. Never applied to cannabis,
 * tobacco or medicines. [DS1109 S2-3]
 */
const DISH_HEADS: ReadonlySet<string> = new Set([
  'cake', 'cakes', 'cupcake', 'cupcakes', 'cheesecake', 'sauce', 'sauces', 'marinade', 'glaze', 'bbq', 'wings', 'chicken', 'pork',
  'ribs', 'steak', 'beef', 'fish', 'shrimp', 'prawns', 'tomato', 'tomatoes', 'chocolate', 'chocolates', 'truffle', 'truffles',
  'fudge', 'toffee', 'candy', 'candies', 'sweets', 'cookie', 'cookies', 'biscuit', 'biscuits', 'brownie', 'brownies', 'muffin',
  'muffins', 'pie', 'pies', 'pudding', 'puddings', 'tart', 'tarts', 'pastry', 'pastries', 'bread', 'jam', 'jelly', 'gelato',
  'sorbet', 'mustard', 'ketchup', 'dressing', 'frosting', 'icing', 'popcorn', 'nuts', 'creamer', 'coffee', 'malta',
  // [DS1110] everyday food ("Carib bean soup", "Hard cider donuts")
  'soup', 'soups', 'stew', 'stews', 'curry', 'rice', 'roti', 'salad', 'sandwich', 'burger', 'burgers', 'pizza', 'pasta', 'noodles',
  'chips', 'fries', 'dip', 'salsa', 'wrap', 'wraps', 'tacos', 'beans', 'donut', 'donuts', 'doughnut', 'doughnuts',
]);
const ends = (words: readonly string[], phrase: readonly string[]) => phrase.every((w, k) => words[words.length - phrase.length + k] === w);
const isDish = (words: readonly string[]) => {
  const last = words[words.length - 1];
  return last !== undefined && (DISH_HEADS.has(last) || DISH_HEADS.has(`${last}s`) || DISH_HEADS.has(`${last}es`) || ends(words, ['ice', 'cream']));
};
const GOODS_LONGEST_FIRST = [...PROHIBITED_GOODS_NOUNS].sort((a, b) => b.split(' ').length - a.split(' ').length).map((p) => p.split(' '));

/** Words that follow a goods noun without changing what it is: sizes, packs, strengths, ages, styles. */
const TRAILING_SIZE = /^(\d+[a-z]{0,6}(\d+[a-z]{0,6})?|ml|cl|dl|l|lt|ltr|ltrs|litre|litres|liter|liters|oz|floz|fl|lb|lbs|kg|g|gm|mg|mcg|gal|gallon|gallons|pint|pints|quart|quarts|pk|pack|packs|ct|count|pc|pcs|piece|pieces|x|s|case|cases|carton|cartons|crate|crates|bottle|bottles|btl|can|cans|tin|tins|nip|nips|flask|flasks|mini|minis|miniature|magnum|jumbo|single|singles|each|puff|puffs|pouch|pouches|refill|refills|no|number|anos|ano|year|years|yr|yrs|yo|old|aged|proof|abv|percent|pct|vol|alc|zero|free|non|alcoholic|alcohol|by|per|the|a|an|of|in|only)$/;
const TRAILING_STYLE: ReadonlySet<string> = new Set([
  'gold', 'golden', 'white', 'dark', 'black', 'amber', 'silver', 'red', 'blush', 'spiced', 'overproof', 'premium', 'reserve',
  'special', 'extra', 'original', 'classic', 'select', 'superior', 'dry', 'sweet', 'brut', 'blanc', 'blanco', 'reposado',
  'anejo', 'light', 'lite', 'strong', 'draft', 'draught', 'imported', 'local', 'craft', 'double', 'triple', 'xo', 'vs',
  'vsop', 'xxo', 'smooth', 'bold', 'export', 'label', 'foreign', 'tinto', 'tinta', 'rosado', 'blanca',
]);
/** Where a name or an option splits into parts: "Rum - Bristol White", "Vodka, Russian Standard", "Beer (non-alcoholic)". */
const SEGMENT_BREAK = /\s+[-–—|]\s+|[,;:|/()[\]{}]/u;

/** The order a mixed text reports its classes in. */
const CLASS_ORDER: readonly ProhibitedClass[] = ['ALCOHOL', 'TOBACCO', 'VAPES', 'DRUGS', 'MEDICINE', 'AGE_RESTRICTED', 'LPG', 'FUEL'];
const CLASS_OF: ReadonlyMap<string, ProhibitedClass> = new Map(
  [...CLASS_ORDER].reverse().flatMap((c) => PROHIBITED_TERMS[c].map((t): [string, ProhibitedClass] => [t, c])),
);

const hasPhrase = (haystack: string, phrase: string): boolean => ` ${haystack} `.includes(` ${phrase} `);
const EXEMPT_LONGEST_FIRST = [...PROHIBITED_EXEMPT_PHRASES].sort((a, b) => b.length - a.length).map((p) => p.split(' '));

/**
 * A word in front of an exempt phrase that makes it the restricted thing after
 * all: "hard ginger beer", "spiked root beer", "alcoholic ginger ale". Such an
 * occurrence is NOT cut, so the drink is judged by its own word. [DS1100 S2]
 */
const EXEMPTION_BREAKERS: ReadonlySet<string> = new Set(['hard', 'spiked', 'boozy', 'alcoholic', 'alcohol', 'adult', 'adults', 'strong', 'stronger', 'strongest']);

/** The exemptions that name a soft drink. A text that states a strength ("5%", "ABV", "proof",
 *  "vol", "alc", "6vol", "5 percent") or carries a breaker word ANYWHERE ("Ginger beer, extra
 *  strong", "Stronger ginger beer") never gets them: such a ginger beer is a drink Swift does not
 *  carry. [DS1103 S2, DS1104 S3/S4] Other exemptions ("rubbing alcohol 70%") are unaffected. */
const SOFT_DRINK_EXEMPTIONS: ReadonlySet<string> = new Set(['ginger beer', 'ginger beers', 'root beer', 'root beers', 'birch beer', 'ginger ale', 'ginger ales']);
const STATES_A_STRENGTH = /%|\d\s*°|\d\s*(abv|proof|alc|vol|volume|percent|per\s*cent|pct)\b|\b(abv|proof|alc|vol|volume|percent|per\s*cent)\b/i;

// ── Disguises [Opus S3-10] ───────────────────────────────────────────────────

/**
 * Unicode's format characters (General Category Cf, Unicode 15.1): zero-width
 * spaces and joiners, the soft hyphen, direction marks, the byte-order mark.
 * Invisible, so "R\u200Bum" reads "Rum". A bracket expression of literal
 * characters, so the database pre-filter removes exactly the same set.
 */
const FORMAT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00AD, 0x00AD], [0x0600, 0x0605], [0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F], [0x0890, 0x0891],
  [0x08E2, 0x08E2], [0x180E, 0x180E], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2064], [0x2066, 0x206F],
  [0xFEFF, 0xFEFF], [0xFFF9, 0xFFFB], [0x110BD, 0x110BD], [0x110CD, 0x110CD], [0x13430, 0x1343F], [0x1BCA0, 0x1BCA3],
  [0x1D173, 0x1D17A], [0xE0001, 0xE0001], [0xE0020, 0xE007F],
];
export const PROHIBITED_FORMAT_CHARS_PATTERN = `[${FORMAT_RANGES.map(([a, b]) => (a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`)).join('')}]`;
const FORMAT_CHARS = new RegExp(PROHIBITED_FORMAT_CHARS_PATTERN, 'gu');

/** Cyrillic and Greek letters that look Latin ("Rцm", "Неineken", "Ηennessy"), one to one, so the database
 *  pre-filter can apply the same table with translate(). */
const CONFUSABLE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['\u0430', 'a'], ['\u0435', 'e'], ['\u0451', 'e'], ['\u043E', 'o'], ['\u0440', 'p'], ['\u0441', 'c'], ['\u0443', 'y'], ['\u0445', 'x'], ['\u0456', 'i'], ['\u0457', 'i'],
  ['\u0458', 'j'], ['\u0455', 's'], ['\u0501', 'd'], ['\u0261', 'g'], ['\u0446', 'u'], ['\u0438', 'u'], ['\u043A', 'k'], ['\u043C', 'm'], ['\u043D', 'h'], ['\u0442', 't'],
  ['\u0433', 'r'], ['\u043F', 'n'], ['\u04CF', 'l'], ['\u0131', 'i'], ['\u0251', 'a'],
  ['\u0410', 'A'], ['\u0412', 'B'], ['\u0415', 'E'], ['\u0401', 'E'], ['\u041A', 'K'], ['\u041C', 'M'], ['\u041D', 'H'], ['\u041E', 'O'], ['\u0420', 'P'], ['\u0421', 'C'],
  ['\u0422', 'T'], ['\u0423', 'Y'], ['\u0425', 'X'], ['\u0405', 'S'], ['\u0406', 'I'], ['\u0407', 'I'], ['\u0408', 'J'],
  ['\u03B1', 'a'], ['\u03BF', 'o'], ['\u03BD', 'v'], ['\u03C1', 'p'], ['\u03C4', 't'], ['\u03C5', 'u'], ['\u03B9', 'i'], ['\u03BA', 'k'], ['\u03B5', 'e'], ['\u03C7', 'x'],
  ['\u0391', 'A'], ['\u0392', 'B'], ['\u0395', 'E'], ['\u0396', 'Z'], ['\u0397', 'H'], ['\u0399', 'I'], ['\u039A', 'K'], ['\u039C', 'M'], ['\u039D', 'N'], ['\u039F', 'O'],
  ['\u03A1', 'P'], ['\u03A4', 'T'], ['\u03A5', 'Y'], ['\u03A7', 'X'],
  // [evasion] Cherokee letters (both cases) and small capitals
  ['\u13AA', 'A'], ['\uAB7A', 'a'], ['\u13F4', 'B'], ['\u13FC', 'b'], ['\u13DF', 'C'], ['\uABAF', 'c'], ['\u13A0', 'D'], ['\uAB70', 'd'], ['\u13AC', 'E'], ['\uAB7C', 'e'], ['\u13C0', 'G'], ['\uAB90', 'g'], ['\u13BB', 'H'], ['\uAB8B', 'h'], ['\u13AB', 'J'], ['\uAB7B', 'j'], ['\u13E6', 'K'], ['\uABB6', 'k'], ['\u13DE', 'L'], ['\uABAE', 'l'], ['\u13B7', 'M'], ['\uAB87', 'm'], ['\u13E2', 'P'], ['\uABB2', 'p'], ['\u13DA', 'S'], ['\uABAA', 's'], ['\u13A2', 'T'], ['\uAB72', 't'], ['\u13D9', 'V'], ['\uABA9', 'v'], ['\u13B3', 'W'], ['\uAB83', 'w'], ['\u13D4', 'W'], ['\uABA4', 'w'], ['\u13C3', 'Z'], ['\uAB93', 'z'], ['\u13A1', 'R'], ['\uAB71', 'r'], ['\u13A5', 'i'], ['\uAB75', 'i'], ['\u1D00', 'a'], ['\u0299', 'b'], ['\u1D04', 'c'], ['\u1D05', 'd'], ['\u1D07', 'e'], ['\u0262', 'g'], ['\u029C', 'h'], ['\u026A', 'i'], ['\u1D0A', 'j'], ['\u1D0B', 'k'], ['\u029F', 'l'], ['\u1D0D', 'm'], ['\u0274', 'n'], ['\u1D0F', 'o'], ['\u1D18', 'p'], ['\u0280', 'r'], ['\uA731', 's'], ['\u1D1B', 't'], ['\u1D1C', 'u'], ['\u1D20', 'v'], ['\u1D21', 'w'], ['\u028F', 'y'], ['\u1D22', 'z'],
];
export const PROHIBITED_CONFUSABLES = {
  from: CONFUSABLE_PAIRS.map(([f]) => f).join(''),
  to: CONFUSABLE_PAIRS.map(([, t]) => t).join(''),
} as const;
const CONFUSABLE = new Map(CONFUSABLE_PAIRS);

/** "Rosé" is the wine; "rose" is the flower. Read before accents are removed (after NFKC, so a decomposed é counts). */
export const PROHIBITED_ROSE_PATTERN = '[rR][oO][sS][éÉ]';
const ROSE = new RegExp(`${PROHIBITED_ROSE_PATTERN}(?=[sS]?(?![\\p{L}\\p{N}]))`, 'gu');

/** Two single letters in a row ("r u m" from "R.U.M"): the database keeps such a row for the exact check. */
export const PROHIBITED_SINGLE_LETTER_RUN_PATTERN = '(^|[^a-z0-9])[a-z][^a-z0-9]+[a-z]([^a-z0-9]|$)';

/** The text as it reads: compatibility forms folded (fullwidth, ligatures), format characters removed,
 *  look-alike letters made Latin, "rosé" spelled out. */
function undisguise(text: string): string {
  const folded = text.normalize('NFKC').replace(FORMAT_CHARS, '');
  return [...folded].map((ch) => CONFUSABLE.get(ch) ?? ch).join('').replace(ROSE, 'rosewine');
}

/** "r u m" → "rum": runs of single letters, joined. Judged beside the text, never instead of it. */
function joinSingleLetters(normalized: string): string {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => { if (run.length >= 2) out.push(run.join('')); else out.push(...run); run = []; };
  for (const w of normalized.split(' ').filter(Boolean)) {
    if (/^[a-z]$/.test(w)) run.push(w);
    else { flush(); out.push(w); }
  }
  flush();
  return out.join(' ');
}

/** A text that takes a soft drink's exemption away: a stated strength, or a qualifier word anywhere. */
function qualifiesSoftDrinks(text: string): boolean {
  return STATES_A_STRENGTH.test(text) || normalize(undisguise(text)).split(' ').some((w) => EXEMPTION_BREAKERS.has(w));
}

function stripExempt(normalized: string, noSoftDrinks: boolean): string {
  let words = normalized.split(' ').filter(Boolean);
  for (const phrase of EXEMPT_LONGEST_FIRST) {
    if (noSoftDrinks && SOFT_DRINK_EXEMPTIONS.has(phrase.join(' '))) continue;
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

/**
 * A brand's own label spelling: the possessive "'s" ("Bailey's", "Buckley's") and "&" for "and"
 * ("Wray & Nephew"). Plain normalizing reads them as "bailey s" and "wray nephew" — words the list
 * does not carry. So a text is judged as written AND in each label spelling; a hit in any is a hit,
 * and none loses a word the text already carried ("Tobacco's" still holds by "tobacco"). [DS1104 S2]
 * Only the classifier joins the "'s": the database pre-filter holds the stem of every listed word
 * ending in "s" instead (see PROHIBITED_PREFILTER_WORDS).
 */
const POSSESSIVE_S = /([\p{L}\p{N}])\s*['‘’`´ʼ]\s*([sS])(?![\p{L}\p{N}])/gu;
/** "&", "+" and a lone "n" read as "and" ("Wray & Nephew", "Wray + Nephew", "Wray n Nephew"). [DS1105 S4] */
const anded = (text: string): string => text.replace(/[&+]/g, ' and ').replace(/(^|[^\p{L}\p{N}])n(?![\p{L}\p{N}])/giu, '$1and');
function labelSpellings(text: string): string[] {
  const unescaped = text.replace(/&amp;/gi, '&'); // a till or a CSV export that escaped the "&"
  const joined = unescaped.replace(POSSESSIVE_S, '$1$2');
  return [...new Set([text, unescaped, joined, anded(unescaped), anded(joined)])];
}

/**
 * l33t spellings ("v4pe", "c1garette", "Hennes$y", "V0DK@"): a digit or a symbol that touches a letter read as the
 * letter it stands for — "1" both as "i" and as "l". Judged beside the text, never instead of it, so "4 pack" and
 * "750ml" keep their meaning. The database pre-filter translates every such character (a superset). [evasion]
 */
export const PROHIBITED_LEET_FROM = '4@3!05$7|';
const LEET_TO = 'aaeiosstl';
const LEET = new Map([...PROHIBITED_LEET_FROM].map((ch, k) => [ch, LEET_TO[k]!]));
const LEET_ANY = /[4@3!05$7|1]/;
/** A token that is a number with its unit ("750ml", "20s", "7up", "1L"): never translated. */
const NUMBER_WITH_UNIT = /^\d+([.,]\d+)?\p{L}{0,6}$/u;
function leetSpellings(text: string): string[] {
  if (!LEET_ANY.test(text)) return [];
  const spell = (one: string) => text.split(/(\s+)/).map((token) => (
    /\p{L}/u.test(token) && LEET_ANY.test(token) && !NUMBER_WITH_UNIT.test(token)
      ? [...token].map((ch) => (ch === '1' ? one : LEET.get(ch) ?? ch)).join('')
      : token)).join('');
  const out = [spell('i'), spell('l')].filter((t) => t !== text);
  return [...new Set(out)];
}

/** "Heinekens", "Coronas": a word with its plural "s" dropped (words of five letters or more), judged beside it. */
const singular = (normalized: string): string =>
  normalized.split(' ').map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');

/** Every reading of a text that is judged: as written and in its l33t spellings, each label spelling, normalized,
 *  with spelled-out letters joined and plurals dropped, exemptions cut. The text is undisguised once, here. */
function readings(text: string, noSoftDrinks: boolean): string[] {
  const out = new Set<string>();
  const plain = undisguise(text);
  for (const base of [plain, ...leetSpellings(plain)]) {
    for (const spelling of labelSpellings(base)) {
      const n = normalize(spelling);
      for (const variant of [n, joinSingleLetters(n)]) {
        const judged = stripExempt(variant, noSoftDrinks);
        if (judged) out.add(judged);
      }
      // the plural dropped AFTER the exemptions are cut ("diesel jeans" stays exempt)
      const dropped = singular(stripExempt(n, noSoftDrinks));
      if (dropped) out.add(dropped);
    }
  }
  return [...out];
}

/** "Hen nessy", "Vod ka": two adjacent words that join into a listed word of four letters or more. Read from the
 *  plain spelling only (the database pre-filter joins the same pairs), and only ever HOLDS. [evasion] */
const SPLIT_TERMS_MIN = 4;
function splitWordHit(text: string): { prohibitedClass: ProhibitedClass; term: string } | null {
  const words = normalize(undisguise(text)).split(' ').filter(Boolean);
  for (let i = 0; i + 1 < words.length; i += 1) {
    const joined = words[i]! + words[i + 1]!;
    if (joined.length >= SPLIT_TERMS_MIN && SINGLE_WORD_TERMS.has(joined)) return { prohibitedClass: CLASS_OF.get(joined)!, term: joined };
  }
  return null;
}

export interface ClassifyOptions {
  /** Take the soft-drink exemptions away whatever this text says: another of the item's own texts states a
   *  strength or a qualifier ("Ginger Beer" named, "8 proof" in its description). [DS1105 S3] */
  noSoftDrinks?: boolean;
  /** Judge the brand-first words (default true: a name, an option, a line on an order). */
  brandFirst?: boolean;
  /** Judge words split in two ("Hen nessy") — default true; a hold only. */
  splitWords?: boolean;
}

/** One text → the first banned class and word it carries, or null. */
export function classifyText(text: string | null | undefined, options: ClassifyOptions = {}): { prohibitedClass: ProhibitedClass; term: string } | null {
  if (!text) return null;
  const noSoftDrinks = options.noSoftDrinks === true || qualifiesSoftDrinks(text);
  const judged = readings(text, noSoftDrinks);
  if (judged.length === 0) return null;
  // The spelling as written names the term first ("rolling papers"); the other readings only when it names none.
  const asWritten = new Set(labelSpellings(undisguise(text)).map((sp) => stripExempt(normalize(sp), noSoftDrinks)));
  for (const pool of [judged.filter((j) => asWritten.has(j)), judged]) {
    for (const prohibitedClass of CLASS_ORDER) {
      for (const term of PROHIBITED_TERMS[prohibitedClass]) {
        if (pool.some((j) => hasPhrase(j, term))) return { prohibitedClass, term };
      }
    }
  }
  if (options.brandFirst !== false) {
    for (const j of judged) {
      const first = j.split(' ')[0]!;
      const brand = BRAND_FIRST[first];
      if (brand) return { prohibitedClass: brand.prohibitedClass, term: first };
    }
  }
  return options.splitWords === false ? null : splitWordHit(text);
}

/** The goods noun heading one part of a name or option, if any ("red wine 750ml" → "wine"). */
/** The words left once the size, pack, strength and style words after them are stripped, and whether one of those
 *  was a drink measure. */
function stripTrailing(words: readonly string[]): { core: readonly string[]; measured: boolean; grams: boolean; liquid: boolean; tobacco: boolean; aged: boolean } {
  let end = words.length;
  let measured = false;
  let grams = false;
  let liquid = false;
  let tobacco = false;
  let aged = false;
  while (end > 0) {
    const w = words[end - 1]!;
    if (!(TRAILING_SIZE.test(w) || TRAILING_STYLE.has(w) || DRINK_MEASURE.test(w) || CANNABIS_MEASURE.test(w))) break;
    if (DRINK_MEASURE.test(w)) measured = true;
    if (CANNABIS_MEASURE.test(w)) grams = true;
    if (LIQUID_MEASURE.test(w)) liquid = true;
    if (TOBACCO_MEASURE.test(w)) tobacco = true;
    if (AGE_STATEMENT.test(w)) aged = true;
    end -= 1;
  }
  return { core: words.slice(0, end), measured, grams, liquid, tobacco, aged };
}

/** The goods noun heading one part of a name or option, if any ("red wine 750ml" → "wine"). */
function headGoods(words: readonly string[]): string | null {
  // "Empty gas cylinder", "Empty Hennessy bottle": a container, not the goods — held for a person. [DS1110 S3-4]
  if (words.includes('empty')) return null;
  const { core, measured, grams } = stripTrailing(words);
  const match = (candidate: readonly string[], medicineOnly: boolean): string | null => {
    for (const phrase of GOODS_LONGEST_FIRST) {
      const start = candidate.length - phrase.length;
      if (start < 0 || !ends(candidate, phrase)) continue;
      const noun = phrase.join(' ');
      if (medicineOnly && CLASS_OF.get(noun) !== 'MEDICINE') continue;
      if (SIZED_ONLY.has(noun) && !measured) return null;
      if (AMBIGUOUS_ALONE.has(noun) && start === 0 && !measured) return null;
      if (ALONE_ONLY.has(noun) && start !== 0) return null;
      if (GRAMS_ONLY.has(noun) && !grams) return null;
      return noun;
    }
    return null;
  };
  const direct = match(core, false);
  if (direct) return direct;
  // A medicine named before its form: strip the form words too, and only a medicine may answer.
  let end = core.length;
  while (end > 0 && (MEDICINE_FORMS.has(core[end - 1]!) || TRAILING_SIZE.test(core[end - 1]!))) end -= 1;
  return end < core.length ? match(core.slice(0, end), true) : null;
}

/** "Banks 6 pack", "Bristol 20s", "XM Gold": a brand-first word followed only by measure and style words. */
function brandPack(words: readonly string[]): { prohibitedClass: ProhibitedClass; term: string } | null {
  const brand = BRAND_FIRST[words[0] ?? ''];
  if (!brand || words.includes('empty')) return null;
  const { core, measured, liquid, tobacco, aged } = stripTrailing(words.slice(1));
  const kind = brand.measure ?? 'any';
  // An alcohol brand's age statement is its measure too ("Bounty 12 year old").
  const spiritAge = brand.prohibitedClass === 'ALCOHOL' && aged;
  const ofItsKind = kind === 'any' ? measured || spiritAge : kind === 'liquid' ? liquid || spiritAge : kind === 'tobacco' ? tobacco : false;
  if (brand.certain || (core.length === 0 && ofItsKind)) return { prohibitedClass: brand.prohibitedClass, term: words[0]! };
  // A medicine brand counted or dosed ("Bayer 30 tabs", "Bayer 325mg") is the medicine. Halls ('none') never is (#58).
  if (brand.prohibitedClass === 'MEDICINE' && kind === 'any' && pillsOnly(words.slice(1))) return { prohibitedClass: 'MEDICINE', term: words[0]! };
  return null;
}

/** Only pill, dose, size and style words, and at least one pill or dose word. */
function pillsOnly(rest: readonly string[]): boolean {
  let dosed = false;
  for (const w of rest) {
    if (PILL_MEASURE.test(w)) dosed = true;
    else if (!(TRAILING_SIZE.test(w) || TRAILING_STYLE.has(w) || DRINK_MEASURE.test(w))) return false;
  }
  return dosed;
}

/**
 * Is an item's NAME or one of its OPTIONS the banned goods themselves — never
 * approvable? A brand or product phrase anywhere in it, a goods noun heading
 * it or one of its parts, or a certain brand-first word. Judged on the text
 * alone: a qualifier written in another field can hold a soft drink, never
 * refuse it ("Ginger beer" with "Strong" in its description is a check, not
 * a ban). [#55/#56, Opus S1-LAUNCH-2]
 */
export function certainGoods(text: string | null | undefined): { prohibitedClass: ProhibitedClass; term: string } | null {
  if (!text) return null;
  const sameText = STATES_A_STRENGTH.test(text);
  const parts = undisguise(text).split(SEGMENT_BREAK).map((part) => readings(part, sameText || STATES_A_STRENGTH.test(part)).map((r) => r.split(' ')));
  // A brand or product phrase: certain — unless an ALCOHOL one names a dish ("Hennessy wings"). [DS1109 S2-3]
  for (const prohibitedClass of CLASS_ORDER) {
    for (const term of PROHIBITED_TERMS[prohibitedClass]) {
      if (!NEVER_APPROVABLE.has(term)) continue;
      const carriers = parts.flat().filter((words) => hasPhrase(words.join(' '), term) && !words.includes('empty'));
      if (carriers.length === 0) continue;
      if (prohibitedClass === 'ALCOHOL' && carriers.every((words) => isDish(stripTrailing(words).core))) continue;
      return { prohibitedClass, term };
    }
  }
  for (const readingsOfPart of parts) {
    for (const words of readingsOfPart) {
      const noun = headGoods(words);
      if (noun) return { prohibitedClass: CLASS_OF.get(noun)!, term: noun };
      const pack = brandPack(words);
      if (pack) return pack;
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
  /** Platform categories the item's STORE chose (not machine-derived): a banned one bans every item of the store. [#54] */
  storeCategories?: ReadonlyArray<{ slug: string; name: string }>;
  /** Set when a person removed the item as prohibited — one way, never undone. */
  prohibitedAt?: Date | null;
  prohibitedClass?: string | null;
  prohibitedReason?: string | null;
  /** The hash of the judged words a person approved, if any. */
  reviewApprovedHash?: string | null;
}

export type BanSource = 'category' | 'store' | 'removed' | 'word';
export type CatalogueCheck =
  | { state: 'BANNED'; prohibitedClass: ProhibitedClass; source: BanSource; term: string | null; reason: string | null; field?: JudgedField }
  | { state: 'WAITING' | 'APPROVED'; prohibitedClass: ProhibitedClass; field: JudgedField; term: string }
  | { state: 'CLEAR' };

/**
 * The partner's text judged: the first word hit, in the order a partner reads
 * it — or, when the name or an option IS the banned goods, that, as certain.
 */
export function wordHit(item: ItemWords): { prohibitedClass: ProhibitedClass; field: JudgedField; term: string; certain: boolean } | null {
  const fields: Array<[JudgedField, string | null | undefined]> = [
    ['name', item.name],
    ['section', item.sectionName],
    ['description', item.description],
    ...(item.optionNames ?? []).map((n): [JudgedField, string | null | undefined] => ['option', n]),
  ];
  // A strength or a qualifier in ANY of the item's own texts takes the soft-drink exemptions away in all of them. [DS1105 S3]
  const noSoftDrinks = fields.some(([, text]) => !!text && qualifiesSoftDrinks(text));
  let first: { prohibitedClass: ProhibitedClass; field: JudgedField; term: string } | null = null;
  for (const [field, text] of fields) {
    const product = field === 'name' || field === 'option';
    const hit = classifyText(text, { noSoftDrinks, brandFirst: product });
    if (!hit) continue;
    const certain = product ? certainGoods(text) : null;
    if (certain) return { ...certain, field, certain: true };
    first ??= { ...hit, field };
  }
  if (!first) {
    // A phrase written across fields ("Captain" named, "Morgan" as the option): the item's own words read together
    // hold it for a person. Never certain, no brand-first word, no split word. [evasion]
    const together = fields.map(([, text]) => text).filter(Boolean).join(' . ');
    const hit = classifyText(together, { noSoftDrinks, brandFirst: false, splitWords: false });
    if (hit) first = { ...hit, field: 'name' };
  }
  return first ? { ...first, certain: false } : null;
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

/** What a partner reads about an item banned because of its STORE's category, not its own words. */
export function storeCategoryReason(categoryName: string): string {
  return `Your store is filed under ${categoryName}, which Swift doesn't allow. Ask Swift support to change your store's category.`;
}

/** The verdict on one item. Certain bans first; approval only ever answers a word hit that is not the goods themselves. */
export function checkItem(item: CatalogueFacts): CatalogueCheck {
  if (item.prohibitedAt) {
    return { state: 'BANNED', prohibitedClass: asClass(item.prohibitedClass) ?? 'AGE_RESTRICTED', source: 'removed', term: null, reason: item.prohibitedReason ?? null };
  }
  for (const category of item.categories ?? []) {
    const hit = classifyCategory(category);
    if (hit) return { state: 'BANNED', prohibitedClass: hit.prohibitedClass, source: 'category', term: hit.term, reason: null };
  }
  for (const category of item.storeCategories ?? []) {
    const hit = classifyCategory(category);
    if (hit) return { state: 'BANNED', prohibitedClass: hit.prohibitedClass, source: 'store', term: hit.term, reason: storeCategoryReason(category.name) };
  }
  const hit = wordHit(item);
  if (!hit) return { state: 'CLEAR' };
  if (hit.certain) return { state: 'BANNED', prohibitedClass: hit.prohibitedClass, source: 'word', term: hit.term, reason: null, field: hit.field };
  const approved = item.reviewApprovedHash != null && item.reviewApprovedHash === judgedWordsHash(item);
  return { state: approved ? 'APPROVED' : 'WAITING', prohibitedClass: hit.prohibitedClass, field: hit.field, term: hit.term };
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
export const PROHIBITED_MARKS_PATTERN = '[\u0300-\u036F]+';

/**
 * The words a database pre-filter looks for, after reading each column as the
 * classifier does (NFKC, format characters removed, look-alikes translated,
 * "rosé" spelled out, NFD, the marks above removed, lowercased, split on every
 * non-letter): a superset of what the word list can match, so the exact
 * judgement above runs only on the rows that could hit. Spelled-out letters
 * ("R.U.M") are kept by PROHIBITED_SINGLE_LETTER_RUN_PATTERN. [DS1100 S2/S3]
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
  'paper', 'papers', 'throat', 'lemonade', 'mall', 'e', 'roll', 'rolls',
  'black', 'martin', 'old', 'lost', 'tablets', 'pills', 'relief', 'reducer', 'refill', 'cylinder', 'lighter', 'sapphire',
  'friend', 'crown', 'famous', 'balm',
]);
const SINGLE_WORD_TERMS: ReadonlySet<string> = new Set(CLASS_ORDER.flatMap((c) => PROHIBITED_TERMS[c]).filter((t) => !t.includes(' ')));
const longest = (words: readonly string[]): string => words.reduce((a, b) => (b.length > a.length ? b : a));

const PREFILTER_BASE: readonly string[] = [
  ...SINGLE_WORD_TERMS,
  ...PROHIBITED_BRAND_FIRST_WORDS,
  ...CLASS_ORDER.flatMap((c) => PROHIBITED_TERMS[c]).filter((t) => t.includes(' ')).flatMap((phrase) => {
    const words = phrase.split(' ');
    if (words.some((w) => SINGLE_WORD_TERMS.has(w))) return [];
    const unusual = words.filter((w) => !ORDINARY_WORDS.has(w));
    return [longest(unusual.length ? unusual : words)];
  }),
];

/** …plus the stem of every word ending in "s": the classifier joins "bailey's" into "baileys",
 *  but the database splits it into "bailey" and "s". ("and" from "&" is never a pre-filter word.)
 *  [DS1104 S2] */
export const PROHIBITED_PREFILTER_WORDS: readonly string[] = [...new Set([
  ...PREFILTER_BASE,
  ...PREFILTER_BASE.filter((w) => w.length > 1 && w.endsWith('s')).map((w) => w.slice(0, -1)),
  // [evasion] a plural the classifier drops ("heinekens" → "heineken")
  ...PREFILTER_BASE.map((w) => `${w}s`),
])].sort();
