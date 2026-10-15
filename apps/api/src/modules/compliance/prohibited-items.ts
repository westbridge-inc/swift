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
 * Owner, 15 Oct 2026 (research A6/A8, R4): the same permanent rule for
 * fireworks, squibs and other explosives (Explosives Act s.13), pesticides and
 * toxic chemicals (Cap. 68:09), raw gold, diamonds and precious stones (a GGMC
 * trading licence), firearms, ammunition and replicas, protected wildlife,
 * counterfeit goods, currency and payment cards — and legal services (Rule VI
 * of the Legal Practitioners' Code: advertising them is barred to "any person
 * whatsoever"). Lottery and gambling products and adult material were already
 * the 18+ class.
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

export type ProhibitedClass = 'ALCOHOL' | 'TOBACCO' | 'VAPES' | 'DRUGS' | 'MEDICINE' | 'AGE_RESTRICTED' | 'LPG' | 'FUEL'
  // [R4 · owner 15 Oct, research A6/A8] the expanded permanent list
  | 'EXPLOSIVES' | 'PESTICIDES' | 'PRECIOUS_MINERALS' | 'WEAPONS' | 'WILDLIFE' | 'COUNTERFEIT' | 'CURRENCY' | 'LEGAL_SERVICES';
/** Where a word was found: the item's own text, or ('store') its STORE's own words, which hold every item it sells. */
export type JudgedField = 'name' | 'description' | 'section' | 'option' | 'store';

export const PROHIBITED_CLASSES: readonly ProhibitedClass[] = [
  'ALCOHOL', 'TOBACCO', 'VAPES', 'DRUGS', 'MEDICINE', 'AGE_RESTRICTED', 'LPG', 'FUEL',
  'EXPLOSIVES', 'PESTICIDES', 'PRECIOUS_MINERALS', 'WEAPONS', 'WILDLIFE', 'COUNTERFEIT', 'CURRENCY', 'LEGAL_SERVICES',
];

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
  EXPLOSIVES: 'fireworks and explosives',
  PESTICIDES: 'pesticides and toxic chemicals',
  PRECIOUS_MINERALS: 'raw gold, diamonds and precious stones',
  WEAPONS: 'firearms, ammunition and replicas',
  WILDLIFE: 'protected wildlife',
  COUNTERFEIT: 'counterfeit goods',
  CURRENCY: 'currency and payment cards',
  LEGAL_SERVICES: 'legal services',
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
    'lottery', 'lotto', 'lottery ticket', 'lottery tickets', 'lotto ticket', 'lotto tickets', 'betting', 'gambling', 'casino',
    'sex toy', 'sex toys', 'adult toy', 'adult toys', 'vibrator', 'vibrators', 'dildo', 'dildos', 'porn', 'pornographic',
    'erotic', 'adults only', 'xxx',
    // [R4 · research A6] more lottery, gambling and adult goods by name
    'raffle ticket', 'raffle tickets', 'scratch off', 'scratch offs', 'slot machine', 'slot machines', 'sports betting',
    'bet slip', 'bet slips', 'pornography', 'porno', 'sex doll', 'sex dolls', 'adult magazine', 'adult magazines',
    'adult movie', 'adult movies', 'adult video', 'adult videos', 'adult dvd', 'adult dvds', 'butt plug', 'butt plugs',
    'cock ring', 'cock rings', 'fleshlight', 'escort service', 'escort services',
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
  // ── [R4 · owner 15 Oct, research A6/A8] The expanded permanent list. Left out because they mean something ordinary
  // far more often than not: bomb (bath bombs), flare (jeans), cartridge (ink, filters), magazine (reading), silencer
  // (an exhaust), mercury alone (outboard engines), ivory alone (a colour, a soap), turtle alone (a neckline), monkey
  // (bread, wrench), poison alone (a perfume), gold and diamond alone (jewellery), coin (chocolate, purses), fake
  // (flowers, lashes), imitation (costume jewellery), dupe, prepaid card (phone credit). Jewellery made of gold or
  // set with stones is not "raw" gold or stones; a store's own gift card is held for a person, not refused.
  EXPLOSIVES: [
    'firework', 'fireworks', 'firecracker', 'firecrackers', 'fire cracker', 'fire crackers', 'squib', 'squibs',
    'explosive', 'explosives', 'dynamite', 'gunpowder', 'gun powder', 'blasting powder',
    'detonator', 'detonators', 'blasting cap', 'blasting caps', 'tnt', 'm80', 'pyrotechnic', 'pyrotechnics',
    'roman candle', 'roman candles', 'skyrocket', 'skyrockets', 'sky rocket', 'sky rockets', 'bottle rocket', 'bottle rockets',
    'cherry bomb', 'cherry bombs', 'smoke bomb', 'smoke bombs', 'sparkler', 'sparklers',
  ],
  PESTICIDES: [
    'pesticide', 'pesticides', 'insecticide', 'insecticides', 'herbicide', 'herbicides', 'fungicide', 'fungicides',
    'rodenticide', 'rodenticides', 'termiticide', 'termiticides', 'larvicide', 'larvicides', 'acaricide', 'acaricides',
    'miticide', 'miticides', 'nematicide', 'nematicides', 'weedkiller', 'weedkillers', 'weed killer', 'weed killers',
    'weed spray', 'weed control', 'weed preventer', 'weed and feed', 'rat poison', 'rat poisons', 'rat bait', 'rodent bait',
    'mouse poison', 'roach poison', 'ant poison', 'poison bait', 'insect killer', 'insect spray', 'bug spray', 'bug killer',
    'roach killer', 'ant killer', 'fly spray', 'mosquito coil', 'mosquito coils', 'toxic chemical', 'toxic chemicals',
    // the active ingredients and brands on Guyanese farm and shop shelves
    'paraquat', 'gramoxone', 'glyphosate', 'diquat', 'atrazine', 'malathion', 'cypermethrin', 'deltamethrin',
    'lambda cyhalothrin', 'chlorpyrifos', 'diazinon', 'carbofuran', 'furadan', 'methomyl', 'lannate', 'mancozeb', 'dithane',
    'ddt', 'fipronil', 'imidacloprid', 'abamectin', 'aldicarb', 'temik', 'phostoxin', 'roundup', 'aluminium phosphide',
    'aluminum phosphide', 'zinc phosphide', 'brodifacoum', 'bromadiolone', 'klerat', 'racumin', 'baygon', 'mortein',
    'cyanide', 'sodium cyanide', 'arsenic', 'strychnine', 'liquid mercury', 'elemental mercury', 'metallic mercury',
  ],
  PRECIOUS_MINERALS: [
    'raw gold', 'gold dust', 'gold nugget', 'gold nuggets', 'gold bar', 'gold bars', 'gold bullion', 'bullion', 'gold ore',
    'alluvial gold', 'unrefined gold', 'scrap gold', 'gold scrap', 'gold concentrate', 'raw diamond', 'raw diamonds',
    'rough diamond', 'rough diamonds', 'uncut diamond', 'uncut diamonds', 'loose diamond', 'loose diamonds',
    'precious stone', 'precious stones', 'semi precious stones', 'gemstone', 'gemstones', 'raw gemstone', 'raw gemstones',
    'rough gemstone', 'rough gemstones', 'uncut gemstone', 'uncut gemstones', 'loose gemstone', 'loose gemstones',
    'raw emerald', 'raw emeralds', 'rough emerald', 'rough emeralds', 'uncut emerald', 'uncut emeralds', 'raw minerals',
    'mineral ore', 'manganese ore', 'bauxite',
  ],
  WEAPONS: [
    'firearm', 'firearms', 'gun', 'guns', 'handgun', 'handguns', 'pistol', 'pistols', 'revolver', 'revolvers', 'rifle', 'rifles',
    'shotgun', 'shotguns', 'ammunition', 'ammo', 'bullets', 'shotgun shell', 'shotgun shells', 'shotgun cartridge',
    'shotgun cartridges', 'rifle cartridge', 'rifle cartridges', 'airsoft', 'bb gun', 'bb guns', 'pellet gun', 'pellet guns',
    'air gun', 'air guns', 'air rifle', 'air rifles', 'air pistol', 'air pistols', 'replica gun', 'replica guns',
    'replica pistol', 'replica pistols', 'replica firearm', 'replica firearms', 'imitation firearm', 'imitation firearms',
    'toy gun', 'toy guns', 'stun gun', 'stun guns', 'taser', 'tasers', 'pepper spray', 'gun parts', 'gun barrel', 'gun silencer',
  ],
  WILDLIFE: [
    'protected wildlife', 'wild animal', 'wild animals', 'exotic pet', 'exotic pets', 'exotic animal', 'exotic animals',
    'exotic bird', 'exotic birds', 'wild bird', 'wild birds', 'songbird', 'songbirds', 'twa twa', 'twatwa', 'towa towa',
    'seed finch', 'seed finches', 'bullfinch', 'bullfinches', 'picolet', 'picolets', 'parrot', 'parrots', 'macaw', 'macaws',
    'toucan', 'toucans', 'harpy eagle', 'ocelot', 'ocelots', 'manatee', 'manatees', 'arapaima', 'giant otter', 'giant otters',
    'sea turtle', 'sea turtles', 'turtle egg', 'turtle eggs', 'turtle meat', 'turtle shell', 'caiman', 'caimans', 'sloth',
    'sloths', 'anteater', 'anteaters', 'jaguar skin', 'jaguar pelt', 'jaguar teeth', 'jaguar tooth', 'jaguar claw',
    'jaguar claws', 'elephant ivory', 'ivory tusk', 'ivory tusks', 'raw ivory', 'rhino horn', 'shark fin', 'shark fins',
    'live monkey', 'pet monkey', 'baby monkey',
  ],
  COUNTERFEIT: [
    'counterfeit', 'counterfeits', 'knockoff', 'knockoffs', 'knock off', 'knock offs', 'bootleg', 'bootlegs', 'pirated',
    'pirate copy', 'first copy', 'master copy', 'super copy', 'mirror quality', 'aaa replica', 'replica', 'replicas',
  ],
  CURRENCY: [
    'banknote', 'banknotes', 'bank note', 'bank notes', 'foreign currency', 'currency exchange', 'money exchange',
    'foreign exchange', 'cambio', 'us dollars', 'us dollar', 'usd cash', 'prop money', 'fake money', 'counterfeit money',
    'credit card', 'credit cards', 'debit card', 'debit cards', 'prepaid visa', 'prepaid mastercard', 'visa gift card',
    'visa gift cards', 'mastercard gift card', 'mastercard gift cards', 'prepaid debit card', 'prepaid credit card',
    'virtual card', 'virtual cards', 'cloned card', 'cloned cards', 'gift card', 'gift cards', 'money order', 'money orders',
    'bitcoin', 'bitcoins', 'cryptocurrency', 'crypto',
  ],
  // A service, not goods: "Swift doesn't allow this item: legal services." A parcel is never refused for these words.
  LEGAL_SERVICES: [
    'legal service', 'legal services', 'legal advice', 'legal consultation', 'legal consultations', 'legal representation',
    'legal aid', 'law firm', 'law firms', 'law office', 'attorney at law', 'attorneys at law', 'attorney services',
    'lawyer services', 'lawyer consultation', 'attorney consultation', 'hire a lawyer', 'hire an attorney', 'notary public',
    'conveyancing', 'conveyancer', 'solicitor', 'solicitors', 'barrister', 'barristers', 'lawyer', 'lawyers', 'attorney',
    'attorneys',
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
  // [R4] weed killers, sprays and preventers are herbicides now (PESTICIDES); the tools and the fabric stay ordinary
  'weed eater', 'weed eaters', 'weed whacker', 'weed wacker', 'weed trimmer',
  'weed barrier', 'weed puller', 'weed block', 'weed control fabric', 'weed control mat', 'weed control membrane',
  // [R4] dishes, teas, tools, toys, fittings and payment wording named after a word of the expanded list
  'gunpowder tea', 'gunpowder green tea', 'gun powder tea', 'firecracker chicken', 'firecracker shrimp', 'dynamite shrimp',
  'dynamite roll', 'dynamite rolls',
  'glue gun', 'glue guns', 'hot glue gun', 'hot glue guns', 'glue gun stick', 'glue gun sticks', 'nail gun', 'nail guns',
  'staple gun', 'staple guns', 'heat gun', 'heat guns', 'spray gun', 'spray guns', 'paint gun', 'paint guns', 'paint spray gun',
  'caulking gun', 'caulking guns', 'caulk gun', 'caulk guns', 'grease gun', 'grease guns', 'massage gun', 'massage guns',
  'water gun', 'water guns', 'squirt gun', 'squirt guns', 'bubble gun', 'bubble guns', 'soldering gun', 'temperature gun',
  'thermometer gun', 'price gun', 'tag gun', 'label gun', 'rivet gun', 'rivet guns', 'blow gun', 'air blow gun', 'foam gun',
  'silicone gun', 'sealant gun', 'washer gun', 'pressure washer gun', 'impact gun', 'inflator gun', 'tyre inflator gun',
  'tire inflator gun', 'air duster gun', 'sandblasting gun', 'sand blasting gun', 'nerf gun', 'nerf guns', 'water pistol',
  'water pistols', 'squirt pistol', 'spray pistol', 'glue pistol', 'pistol grip', 'gun metal', 'gun grey', 'gun gray', 'top gun',
  'shotgun microphone', 'shotgun mic',
  'bullion cube', 'bullion cubes', 'bullion fringe', 'bullion embroidery',
  'parrot fish', 'parrot fishes', 'shark fin antenna',
  'counterfeit detector', 'counterfeit detector pen', 'counterfeit pen', 'counterfeit money detector', 'counterfeit bill detector',
  'anti counterfeit', 'bootleg jeans', 'bootleg pants', 'bootleg trousers', 'bootleg leggings', 'bootleg cut',
  'credit card holder', 'credit card holders', 'credit card wallet', 'credit card wallets', 'credit card case',
  'credit card cases', 'credit card sleeve', 'credit card sleeves', 'credit card reader', 'credit card readers',
  'credit card machine', 'credit card size', 'credit card sized', 'credit card knife', 'credit card tool', 'debit card holder',
  'gift card holder', 'gift card holders', 'gift card box', 'gift card boxes', 'gift card envelope', 'gift card envelopes',
  'accept credit cards', 'accept credit card', 'accept debit cards', 'accept debit card', 'accepts credit cards',
  'accepts debit cards', 'credit cards accepted', 'debit cards accepted', 'credit card accepted', 'debit card accepted',
  'pay by credit card', 'pay by debit card', 'pay with credit card', 'pay with debit card', 'credit card payment',
  'credit card payments', 'debit card payment', 'debit card payments',
  'power of attorney', 'no solicitors',
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
  // [R4] adult goods by name
  'sex doll', 'sex dolls', 'pornography', 'porno', 'butt plug', 'butt plugs', 'cock ring', 'cock rings', 'fleshlight',
  // [R4] explosives that are nothing else
  'squib', 'squibs', 'detonator', 'detonators', 'blasting cap', 'blasting caps', 'blasting powder', 'm80',
  // [R4] pesticides and poisons by name (a household insect spray or coil is held for a person — see PESTICIDES)
  'paraquat', 'gramoxone', 'glyphosate', 'diquat', 'atrazine', 'malathion', 'cypermethrin', 'deltamethrin', 'lambda cyhalothrin',
  'chlorpyrifos', 'diazinon', 'carbofuran', 'furadan', 'methomyl', 'lannate', 'mancozeb', 'dithane', 'ddt', 'fipronil',
  'imidacloprid', 'abamectin', 'aldicarb', 'temik', 'phostoxin', 'aluminium phosphide', 'aluminum phosphide', 'zinc phosphide',
  'brodifacoum', 'bromadiolone', 'klerat', 'racumin', 'cyanide', 'sodium cyanide', 'strychnine', 'rat poison', 'rat poisons',
  'weedkiller', 'weedkillers', 'weed killer', 'weed killers',
  // [R4] raw gold, raw stones and ores (jewellery is not here)
  'raw gold', 'gold ore', 'alluvial gold', 'unrefined gold', 'scrap gold', 'gold scrap', 'gold concentrate', 'gold bullion',
  'raw diamond', 'raw diamonds', 'rough diamond', 'rough diamonds', 'uncut diamond', 'uncut diamonds', 'loose diamond',
  'loose diamonds', 'raw gemstone', 'raw gemstones', 'rough gemstone', 'rough gemstones', 'uncut gemstone', 'uncut gemstones',
  'loose gemstone', 'loose gemstones', 'raw emerald', 'raw emeralds', 'rough emerald', 'rough emeralds', 'uncut emerald',
  'uncut emeralds', 'manganese ore', 'mineral ore',
  // [R4] firearms, ammunition and replicas by name ("air gun" is also a workshop blow gun: held, not here)
  'firearm', 'firearms', 'handgun', 'handguns', 'ammunition', 'airsoft', 'bb gun', 'bb guns', 'pellet gun', 'pellet guns',
  'air rifle', 'air rifles', 'air pistol', 'air pistols', 'replica gun', 'replica guns', 'replica pistol', 'replica pistols',
  'replica firearm', 'replica firearms', 'imitation firearm', 'imitation firearms', 'stun gun', 'stun guns', 'taser', 'tasers',
  'shotgun shell', 'shotgun shells', 'shotgun cartridge', 'shotgun cartridges', 'rifle cartridge', 'rifle cartridges', 'gun silencer',
  // [R4] parts of protected animals
  'turtle egg', 'turtle eggs', 'turtle meat', 'jaguar skin', 'jaguar pelt', 'jaguar teeth', 'jaguar tooth', 'jaguar claw',
  'jaguar claws', 'elephant ivory', 'ivory tusk', 'ivory tusks', 'raw ivory', 'rhino horn',
  // [R4] counterfeits that say so
  'counterfeit', 'counterfeits', 'knockoff', 'knockoffs', 'first copy', 'super copy', 'aaa replica', 'pirated', 'pirate copy',
  // [R4] currency and payment cards
  'banknote', 'banknotes', 'bank note', 'bank notes', 'foreign currency', 'prop money', 'fake money', 'counterfeit money',
  'prepaid visa', 'prepaid mastercard', 'visa gift card', 'visa gift cards', 'mastercard gift card', 'mastercard gift cards',
  'prepaid debit card', 'prepaid credit card', 'cloned card', 'cloned cards',
  // [R4 · A8] legal services offered as such
  'legal service', 'legal services', 'legal advice', 'legal consultation', 'legal consultations', 'legal representation',
  'attorney services', 'lawyer services', 'lawyer consultation', 'attorney consultation', 'conveyancing',
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
  'lottery ticket', 'lottery tickets', 'lotto ticket', 'lotto tickets', 'sex toy', 'sex toys', 'adult toy', 'adult toys', 'vibrator', 'vibrators',
  'dildo', 'dildos', 'wine coolers',
  'cerveza', 'cervezas', 'cerveja', 'cervejas', 'biere', 'bieres', 'bier', 'birra', 'vino', 'vinos', 'vinho', 'aguardiente',
  'tabaco', 'cigarro', 'cigarros', 'cigarrillo', 'cigarrillos',
  // [DS1109] sold with a size only ("Marsala 750ml"; "Chicken Marsala" and "Madeira cake" are dishes) — see SIZED_ONLY
  'rosewines', 'cider', 'ciders', 'madeira', 'marsala', 'amaretto', 'limoncello', 'pisco', 'irish cream',
  // [R4] the expanded list, sold as such ("Fireworks 10 pack", "Insecticide 1L", "Toy pistol", "Twa twa"); elsewhere
  // they hold ("Firecracker popsicle", "Rifle scope", "Pistol grip" is ordinary)
  'pornography', 'porno', 'sex doll', 'sex dolls', 'adult magazine', 'adult magazines', 'adult movie', 'adult movies',
  'adult video', 'adult videos', 'adult dvd', 'adult dvds', 'slot machine', 'slot machines',
  'firework', 'fireworks', 'firecracker', 'firecrackers', 'fire cracker', 'fire crackers', 'squib', 'squibs', 'explosives',
  'dynamite', 'gunpowder', 'gun powder', 'detonator', 'detonators', 'blasting caps', 'tnt', 'pyrotechnics', 'roman candle',
  'roman candles', 'skyrocket', 'skyrockets', 'sky rocket', 'sky rockets', 'bottle rocket', 'bottle rockets', 'cherry bomb',
  'cherry bombs', 'sparklers', 'smoke bomb', 'smoke bombs',
  'pesticide', 'pesticides', 'insecticide', 'insecticides', 'herbicide', 'herbicides', 'fungicide', 'fungicides', 'rodenticide',
  'rodenticides', 'termiticide', 'termiticides', 'larvicide', 'larvicides', 'weedkiller', 'weedkillers', 'weed killer',
  'weed killers', 'rat poison', 'rat poisons', 'rat bait', 'rodent bait', 'poison bait', 'toxic chemicals',
  'gold nugget', 'gold nuggets', 'precious stone', 'precious stones', 'semi precious stones',
  'pistol', 'pistols', 'revolver', 'revolvers', 'rifle', 'rifles', 'shotgun', 'shotguns', 'ammo', 'bullets',
  'twa twa', 'twatwa', 'towa towa', 'seed finch', 'seed finches', 'picolet', 'picolets',
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
  if (last === undefined) return false;
  // "curries" (and its singular reading "currie") → "curry" [DS1112 S4-1]
  return [last, `${last}s`, `${last}es`].some((w) => DISH_HEADS.has(w) || (w.endsWith('ies') && DISH_HEADS.has(`${w.slice(0, -3)}y`)))
    || ends(words, ['ice', 'cream']);
};
const GOODS_LONGEST_FIRST = [...PROHIBITED_GOODS_NOUNS].sort((a, b) => b.split(' ').length - a.split(' ').length).map((p) => p.split(' '));
/** [R4] The same list by its LAST word, in the same order: a noun that ends a name ends with the name's last word, so
 *  headGoods only tries those. */
const GOODS_BY_LAST: ReadonlyMap<string, ReadonlyArray<readonly string[]>> = GOODS_LONGEST_FIRST.reduce((m, phrase) => {
  const last = phrase[phrase.length - 1]!;
  m.set(last, [...(m.get(last) ?? []), phrase]);
  return m;
}, new Map<string, Array<readonly string[]>>());

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
// [R4] PESTICIDES reads before DRUGS: a "weed killer" is a herbicide, not cannabis. WEAPONS before COUNTERFEIT: a
// "replica gun" is a replica firearm. LEGAL_SERVICES last: a service, never a reason to refuse a parcel.
const CLASS_ORDER: readonly ProhibitedClass[] = [
  'ALCOHOL', 'TOBACCO', 'VAPES', 'PESTICIDES', 'DRUGS', 'MEDICINE', 'AGE_RESTRICTED', 'LPG', 'FUEL',
  'EXPLOSIVES', 'WEAPONS', 'PRECIOUS_MINERALS', 'WILDLIFE', 'COUNTERFEIT', 'CURRENCY', 'LEGAL_SERVICES',
];
const CLASS_OF: ReadonlyMap<string, ProhibitedClass> = new Map(
  [...CLASS_ORDER].reverse().flatMap((c) => PROHIBITED_TERMS[c].map((t): [string, ProhibitedClass] => [t, c])),
);

const hasPhrase = (haystack: string, phrase: string): boolean => ` ${haystack} `.includes(` ${phrase} `);
/** [R4] A phrase can only be in a text whose words include the phrase's first word: the term loops below skip every
 *  term whose first word the text does not carry, so their cost no longer grows with the length of the list. The
 *  verdict is the same — this only skips a search that cannot match. */
const TERM_HEAD: ReadonlyMap<string, string> = new Map(CLASS_ORDER.flatMap((c) => PROHIBITED_TERMS[c]).map((t) => [t, t.split(' ')[0]!]));
const wordsOf = (texts: readonly string[]): ReadonlySet<string> => new Set(texts.flatMap((t) => t.split(' ')));
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
  // [DS1112 S3-3] the small capitals F and Q (Unicode has no small capital X)
  ['\uA730', 'f'], ['\uA7AF', 'q'],
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
  if (STATES_A_STRENGTH.test(text)) return true;
  // Its l33t spellings too ("str0ng", "5 p3rc3nt"), in whichever field it is written. [DS1112 S3-2]
  const plain = undisguise(text);
  return [plain, ...leetSpellings(plain)].some((t) => STATES_A_STRENGTH.test(t) || normalize(t).split(' ').some((w) => EXEMPTION_BREAKERS.has(w)));
}

function stripExempt(normalized: string, noSoftDrinks: boolean): string {
  let words = normalized.split(' ').filter(Boolean);
  // [R4] Cutting only ever removes words, so a phrase whose first word the text never carried cannot be cut.
  const carried = new Set(words);
  for (const phrase of EXEMPT_LONGEST_FIRST) {
    if (!carried.has(phrase[0]!)) continue;
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

/**
 * Words written together, read apart too [joined spellings]:
 *   · a word joined to the next one where the case changes ("HennessyVS", "RumBottle", "XMRum", "750mlRum") —
 *     PROHIBITED_CAMEL_PATTERNS mark the places, in the undisguised text while it still has its capitals;
 *   · a word joined to the number after it ("Rum750ml", "Marlboro20s", "Panadol500mg") — at
 *     PROHIBITED_DIGITS_APART_PATTERN, in the normalized text.
 * The classifier reads a run apart only when EVERY part is a word (three letters or more), an acronym or a measure —
 * so a code or a random reference ("rXLsF64O", "Rx4ypN") is never carved into a banned fragment. Judged beside the
 * text as written, never instead of it, so "6pack", "20lb" and "7up" keep their meaning. The database pre-filter splits
 * at every such place, whatever the parts (a superset), so it keeps every row these readings can hit.
 */
export const PROHIBITED_CAMEL_PATTERNS: readonly (readonly [string, string])[] = [['([a-z0-9])([A-Z])', '$1 $2'], ['([A-Z])([A-Z][a-z])', '$1 $2']];
export const PROHIBITED_DIGITS_APART_PATTERN = '([a-z])([0-9])';
const CAMEL = PROHIBITED_CAMEL_PATTERNS.map(([pattern, to]) => [new RegExp(pattern, 'g'), to] as const);
/** A number written with its unit ("750ml", "1L", "20s", "500mg", "12yr", "5000puffs"), or a bare number. */
const JOINED_MEASURE = /^\d+([.,]\d+)?(ml|cl|dl|l|lt|ltr|ltrs|litre|litres|liter|liters|oz|floz|fl|s|pk|pack|packs|ct|pc|pcs|mg|mcg|g|gm|kg|lb|lbs|gal|yr|yrs|yo|y|puff|puffs|tab|tabs|cap|caps|x)?$/i;
/** A word (three letters or more, capitalized or not) or an acronym ("VS", "XM"). */
const CAMEL_PART = /^([A-Z][a-z]{2,}|[a-z]{3,}|[A-Z]{2,})$/;
const camelApart = (text: string): string => text.split(/([^A-Za-z0-9]+)/).map((run) => {
  const parts = CAMEL.reduce((t, [pattern, to]) => t.replace(pattern, to), run).split(' ');
  return parts.length > 1 && parts.every((part) => CAMEL_PART.test(part) || JOINED_MEASURE.test(part)) ? parts.join(' ') : run;
}).join('');
const DIGITS_APART = new RegExp(PROHIBITED_DIGITS_APART_PATTERN);
const digitsApart = (normalized: string): string => normalized.split(' ').map((word) => {
  const at = word.search(DIGITS_APART);
  if (at < 0) return word;
  const [letters, measure] = [word.slice(0, at + 1), word.slice(at + 1)];
  // the letter o read as a zero inside the number, as numberLeet does ("2os" for "20s")
  const asMeasure = measure.replace(/^\d[\do]*/, (digits) => digits.replace(/o/g, '0'));
  return /^[a-z]{2,}$/.test(letters) && JOINED_MEASURE.test(asMeasure) ? `${letters} ${measure}` : word;
}).join(' ');

/** Every reading of a text that is judged: as written and in its l33t spellings, each label spelling, normalized,
 *  with spelled-out letters joined and plurals dropped, exemptions cut — and with joined words read apart. The text
 *  is undisguised once, here. */
function readings(text: string, noSoftDrinks: boolean): string[] {
  const out = new Set<string>();
  const plain = undisguise(text);
  // "R0sé" reads "Rosé" only once its l33t is read, so "rosé" is spelled out again after it. [DS1112 S3-1]
  const spelled = [plain, ...leetSpellings(plain).map((t) => t.replace(ROSE, 'rosewine'))];
  // [joined spellings] Each, with its words apart where the case changes, is a base of its own ("H3nn3ssyVS").
  for (const base of new Set(spelled.flatMap((b) => [b, camelApart(b)]))) {
    for (const spelling of labelSpellings(base)) {
      const n = normalize(spelling);
      for (const variant of [n, joinSingleLetters(n), digitsApart(n)]) {
        const judged = stripExempt(variant, noSoftDrinks);
        if (judged) out.add(judged);
      }
      // the plural dropped AFTER the exemptions are cut ("diesel jeans" stays exempt) — joined words apart too
      // ("Heinekens6pack")
      for (const variant of new Set([n, digitsApart(n)])) {
        const dropped = singular(stripExempt(variant, noSoftDrinks));
        if (dropped) out.add(dropped);
      }
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
    const present = wordsOf(pool);
    for (const prohibitedClass of CLASS_ORDER) {
      for (const term of PROHIBITED_TERMS[prohibitedClass]) {
        if (!present.has(TERM_HEAD.get(term)!)) continue;
        if (pool.some((j) => hasPhrase(j, term))) return { prohibitedClass, term };
      }
    }
  }
  if (options.brandFirst !== false) {
    for (const j of judged) {
      // A count before the brand ("1 Camel", "Two Newport") leaves it first. [DS1261]
      const first = afterLeadingCount(j.split(' '))[0]!;
      const brand = BRAND_FIRST[first];
      if (brand) return { prohibitedClass: brand.prohibitedClass, term: first };
    }
    // Anywhere else, with a measure of its kind in either order ("Pack of Camel 20s", "20s Camel"), it is held for a
    // person too. [DS1261 S2, DS1263 S3]
    for (const reading of measureReadings(text, noSoftDrinks)) {
      const hit = brandWithMeasure(reading.split(' '));
      if (hit) return hit;
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
    for (const phrase of GOODS_BY_LAST.get(candidate[candidate.length - 1] ?? '') ?? []) {
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

/** Counts written before a brand-first word ("1 Camel 20s", "Two Newport 20s", "2x Stag"): a quantity, not another
 *  product, so the brand is still the first word. [DS1261] */
const LEADING_COUNT = /^(\d+x?|x\d+|x|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen)$/;
/** A count, in digits or spelled out ("20", "twenty", "fifteen"). [DS1264 S3, DS1265 S4] */
const COUNT = /^(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen)$/;
function afterLeadingCount(words: readonly string[]): readonly string[] {
  let start = 0;
  while (start < words.length - 1 && LEADING_COUNT.test(words[start]!)) start += 1;
  return words.slice(start);
}

/** "2o" for "20", "2os" for "20s": the letter o written for a zero in a number. [DS1263 S3] */
function numberLeet(w: string): string {
  return /^\d+(o+s?|[o\d]*\d)$/.test(w) ? w.replace(/o/g, '0') : w;
}

/** Digits of any script as ASCII ("\u0662\u0660" → "20"): Unicode keeps every script's decimal digits in runs of ten,
 *  0 to 9. [DS1264 S3] */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const at = digit.codePointAt(0)!;
    let start = at;
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((at - start) % 10);
  });
}

/** The text's readings for a measure: "20$" is read as "20s" (the dollar sign is a letter s, as in "Hennes$y"), the
 *  letter o in a number as a zero, digits of any script as ASCII, a brand joined to its measure apart ("Camel20s", a
 *  zero-width space between), and a number with its unit written apart together ("20 ct" → "20ct"). [DS1263 S3,
 *  DS1264 S3] */
function measureReadings(text: string, noSoftDrinks: boolean): string[] {
  const out = new Set<string>();
  for (const reading of readings(asciiDigits(text).replace(/(\d)\$/g, '$1s'), noSoftDrinks)) {
    const spaced = reading.replace(/([a-z])(\d)/g, '$1 $2').split(' ').map(numberLeet).join(' ');
    out.add(spaced);
    out.add(spaced.replace(/\b(\d+) (s|ct|pk|pc|pcs|pack|packs)\b/g, '$1$2'));
  }
  return [...out];
}

/**
 * A brand-first word anywhere in the text with a measure of its kind anywhere else in it, in either order: "Pack of
 * Camel 20s", "Camel Blue 20 pack king size", "20s Camel", "Camel, 20s". For a tobacco or medicine brand, a bare count
 * right after or just before it is its measure too ("Camel 20", "Bayer 30", "twenty Camel"). The catalogue holds it for a person; a parcel, which no
 * person reviews, is refused. A lozenge brand counts by any measure here: it is only ever held in the catalogue (#58).
 * An "empty" container is not let through either: held, as "Empty Hennessy bottle" is (DS1110 S3-4). [DS1261 S2,
 * DS1263 S2/S3]
 */
function brandWithMeasure(words: readonly string[]): { prohibitedClass: ProhibitedClass; term: string } | null {
  for (let i = 0; i < words.length; i += 1) {
    const brand = BRAND_FIRST[words[i]!];
    if (!brand) continue;
    const others = words.filter((_, j) => j !== i);
    const kind = brand.measure === 'none' ? 'any' : brand.measure ?? 'any';
    const aged = brand.prohibitedClass === 'ALCOHOL' && others.some((w) => AGE_STATEMENT.test(w));
    const ofItsKind = kind === 'any' ? aged || others.some((w) => DRINK_MEASURE.test(w))
      : kind === 'liquid' ? aged || others.some((w) => LIQUID_MEASURE.test(w))
        : others.some((w) => TOBACCO_MEASURE.test(w));
    const dosed = brand.prohibitedClass === 'MEDICINE' && others.some((w) => PILL_MEASURE.test(w));
    // A count right after it, or just before it ("Camel 20", "Camel twenty", "twenty Camel", "20 ct Camel"). [DS1264 S3]
    const counted = (brand.prohibitedClass === 'TOBACCO' || brand.prohibitedClass === 'MEDICINE')
      && [words[i + 1], words[i - 1], words[i - 2]].some((w) => COUNT.test(w ?? ''));
    if (ofItsKind || dosed || counted) return { prohibitedClass: brand.prohibitedClass, term: words[i]! };
  }
  return null;
}

/** "Banks 6 pack", "Bristol 20s", "XM Gold": a brand-first word followed only by measure and style words. */
function brandPack(written: readonly string[], options: GoodsOptions = {}): { prohibitedClass: ProhibitedClass; term: string } | null {
  const words = afterLeadingCount(written);
  const brand = BRAND_FIRST[words[0] ?? ''];
  if (!brand || words.includes('empty')) return null;
  const { core, measured, liquid, tobacco, aged } = stripTrailing(words.slice(1));
  // A word held for a person by its own rule (Halls, #58) is judged by any measure where no person stands behind
  // the text — a parcel. [DS1112 S4-2]
  const kind = brand.measure === 'none' && options.noReviewer ? 'any' : brand.measure ?? 'any';
  // An alcohol brand's age statement is its measure too ("Bounty 12 year old").
  const spiritAge = brand.prohibitedClass === 'ALCOHOL' && aged;
  const ofItsKind = kind === 'any' ? measured || spiritAge : kind === 'liquid' ? liquid || spiritAge : kind === 'tobacco' ? tobacco : false;
  if (brand.certain || (core.length === 0 && ofItsKind)) return { prohibitedClass: brand.prohibitedClass, term: words[0]! };
  // Where no person reviews the text (a parcel), the words between the brand and its measure do not make it something
  // else ("Camel Blue 20 pack", "Halls Honey Lemon 9 pack"); the catalogue holds these for a person. [DS1260 S2]
  if (options.noReviewer && ofItsKind) return { prohibitedClass: brand.prohibitedClass, term: words[0]! };
  // A medicine brand counted or dosed ("Bayer 30 tabs", "Bayer 325mg") is the medicine. Halls ('none') never is (#58).
  if (brand.prohibitedClass === 'MEDICINE' && kind === 'any'
    && (pillsOnly(words.slice(1)) || (options.noReviewer === true && pillsAtEnd(words.slice(1))))) {
    return { prohibitedClass: 'MEDICINE', term: words[0]! };
  }
  return null;
}

/** Ends in pill, dose, size and style words, at least one of them a pill or a dose ("One A Day 100 tablets"). */
function pillsAtEnd(rest: readonly string[]): boolean {
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const w = rest[i]!;
    if (PILL_MEASURE.test(w)) return true;
    if (!(TRAILING_SIZE.test(w) || TRAILING_STYLE.has(w) || DRINK_MEASURE.test(w))) return false;
  }
  return false;
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

export interface GoodsOptions {
  /** No person reviews this text (a parcel's description): a measured brand held elsewhere for a person is refused. */
  noReviewer?: boolean;
}

/**
 * Is an item's NAME or one of its OPTIONS the banned goods themselves — never
 * approvable? A brand or product phrase anywhere in it, a goods noun heading
 * it or one of its parts, or a certain brand-first word. Judged on the text
 * alone: a qualifier written in another field can hold a soft drink, never
 * refuse it ("Ginger beer" with "Strong" in its description is a check, not
 * a ban). [#55/#56, Opus S1-LAUNCH-2]
 */
export function certainGoods(text: string | null | undefined, options: GoodsOptions = {}): { prohibitedClass: ProhibitedClass; term: string } | null {
  if (!text) return null;
  const sameText = STATES_A_STRENGTH.test(text);
  const parts = undisguise(text).split(SEGMENT_BREAK).map((part) => readings(part, sameText || STATES_A_STRENGTH.test(part)).map((r) => r.split(' ')));
  // A brand or product phrase: certain — unless an ALCOHOL one names a dish ("Hennessy wings"). [DS1109 S2-3]
  const present = new Set(parts.flat(2));
  for (const prohibitedClass of CLASS_ORDER) {
    for (const term of PROHIBITED_TERMS[prohibitedClass]) {
      if (!NEVER_APPROVABLE.has(term) || !present.has(TERM_HEAD.get(term)!)) continue;
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
      const pack = brandPack(words, options);
      if (pack) return pack;
    }
  }
  return null;
}

/**
 * A parcel's description (owner #67): no reviewer stands behind it, so any listed word refuses it, and so does a
 * brand-first word with a measure — a lozenge brand's too ("Halls 9 pack": #58 holds it for a person, and a parcel
 * has none). A brand-first word alone does not ("Banks birthday card", "Tiger brand shirt"). [DS1109 S4-1, DS1112 S4-2]
 */
export function parcelProhibited(text: string | null | undefined): { prohibitedClass: ProhibitedClass; term: string } | null {
  if (!text) return null;
  // [R4] Legal services are a listing rule, not goods: "Papers for my lawyer" is judged by the goods words alone.
  const goods = (hit: { prohibitedClass: ProhibitedClass; term: string } | null) => (hit && !PARCEL_EXEMPT_CLASSES.has(hit.prohibitedClass) ? hit : null);
  return goods(classifyText(text, { brandFirst: false })) ?? goods(certainGoods(text, { noReviewer: true })) ?? parcelBrandWithMeasure(text);
}
/** Classes that judge listings only: never a reason to refuse a parcel. */
const PARCEL_EXEMPT_CLASSES: ReadonlySet<ProhibitedClass> = new Set(['LEGAL_SERVICES']);

/** No person reviews a parcel: it is read whole, so a brand-first word with a measure of its kind anywhere in it, in
 *  any part and either order, is the goods ("Camel, 20s", "20s Camel", "Camel 20$"). [DS1261 S2, DS1263 S2/S3] */
function parcelBrandWithMeasure(text: string): { prohibitedClass: ProhibitedClass; term: string } | null {
  for (const reading of measureReadings(text, true)) {
    const hit = brandWithMeasure(reading.split(' '));
    if (hit) return hit;
  }
  return null;
}

/**
 * [R4 · research A8] Words that OFFER legal services. Advertising legal services is barred to "any person whatsoever"
 * (Rule VI, Legal Practitioners Act), so a service provider's own profile may not offer them, whatever trade it
 * names. The bare titles ("lawyer", "attorney") are left out: a profile may mention one without offering a service
 * ("my brother is a lawyer"); the catalogue still holds them for a person.
 */
const LEGAL_SERVICE_OFFERS: readonly string[] = PROHIBITED_TERMS.LEGAL_SERVICES
  .filter((t) => !['lawyer', 'lawyers', 'attorney', 'attorneys', 'solicitor', 'solicitors', 'barrister', 'barristers', 'conveyancer'].includes(t));
export function offersLegalServices(text: string | null | undefined): string | null {
  if (!text) return null;
  const judged = readings(text, false);
  return LEGAL_SERVICE_OFFERS.find((term) => judged.some((j) => hasPhrase(j, term))) ?? null;
}

// ── Remembered verdicts [PERF] ───────────────────────────────────────────────
//
// Judging words is pure: the same words always get the same verdict (nothing
// here reads the clock, the database or the environment, and the lists above
// are fixed for the life of the process). It is also slow, a few milliseconds
// per item, and every menu, storefront and Market read judged every item it
// showed, again, on every request: a 100-item menu spent about 0.6 s of the
// API's single thread on it. So the three judges below remember their answers
// for the exact words they were given (the key is every input, in order), in a
// bounded table. A new or changed word is simply a new key, judged fresh; a
// deploy with new lists starts with an empty table. Each caller gets its own
// copy of a remembered answer, so no caller can change another's.

/** The most answers each judge remembers (oldest dropped first). */
export const PROHIBITED_MEMO_MAX = 10_000;

function rememberedJudge<A, R extends object>(keyOf: (_input: A) => string, judge: (_input: A) => R | null): { judge: (_input: A) => R | null; size: () => number } {
  const table = new Map<string, R | null>();
  return {
    judge: (input) => {
      const key = keyOf(input);
      let answer = table.get(key);
      if (answer === undefined) {
        answer = judge(input);
        if (table.size >= PROHIBITED_MEMO_MAX) table.delete(table.keys().next().value!);
      } else {
        table.delete(key);
      }
      table.set(key, answer);
      return answer === null ? null : { ...answer };
    },
    size: () => table.size,
  };
}

/** A platform (discovery) category, judged by its immutable slug and its name — never its aliases. Not remembered. */
export function judgeCategory(category: { slug: string; name: string }): { prohibitedClass: ProhibitedClass; term: string } | null {
  return classifyText(`${category.slug.replace(/-/g, ' ')} ${category.name}`);
}
const categoryJudge = rememberedJudge((category: { slug: string; name: string }) => JSON.stringify([category.slug, category.name]), judgeCategory);

/** A platform (discovery) category, judged by its immutable slug and its name — never its aliases. */
export function classifyCategory(category: { slug: string; name: string }): { prohibitedClass: ProhibitedClass; term: string } | null {
  return categoryJudge.judge(category);
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
  /** The verdict on the item's STORE's own words (`checkStore`): a store held for a person holds every item it sells. */
  store?: StoreCheck;
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
export function judgeItemWords(item: ItemWords): { prohibitedClass: ProhibitedClass; field: JudgedField; term: string; certain: boolean } | null {
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
const itemWordsJudge = rememberedJudge(
  (item: ItemWords) => JSON.stringify([item.name, item.sectionName ?? null, item.description ?? null, (item.optionNames ?? []).map((name) => name ?? null)]),
  judgeItemWords,
);

/**
 * The partner's text judged: the first word hit, in the order a partner reads
 * it — or, when the name or an option IS the banned goods, that, as certain.
 * Remembered for these exact words (see "Remembered verdicts").
 */
export function wordHit(item: ItemWords): { prohibitedClass: ProhibitedClass; field: JudgedField; term: string; certain: boolean } | null {
  return itemWordsJudge.judge(item);
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
  if (hit?.certain) return { state: 'BANNED', prohibitedClass: hit.prohibitedClass, source: 'word', term: hit.term, reason: null, field: hit.field };
  // [owner 14 Oct, store names] A store whose own words are held for a person holds every item it sells, whatever the
  // item's words — an approval of the item's words does not show it while its store waits.
  if (item.store?.state === 'WAITING') return { state: 'WAITING', prohibitedClass: item.store.prohibitedClass, field: 'store', term: item.store.term };
  if (!hit) return { state: 'CLEAR' };
  const approved = item.reviewApprovedHash != null && item.reviewApprovedHash === judgedWordsHash(item);
  return { state: approved ? 'APPROVED' : 'WAITING', prohibitedClass: hit.prohibitedClass, field: hit.field, term: hit.term };
}

// ── Store names (owner, 14 Oct 2026) ─────────────────────────────────────────

/**
 * A store's own words — its name, its description, its tags and cuisine labels: what a customer reads about the store
 * itself ("X Liquor Store", "Rum Shop", "Bourda Pharmacy"). The web address is not judged: it is made from the name
 * when the store is created (and judged then, through the name), and its random ending would hold stores by chance.
 */
export interface StoreWords {
  name: string;
  description?: string | null;
  tags?: ReadonlyArray<string | null | undefined>;
  cuisineTypes?: ReadonlyArray<string | null | undefined>;
}
/** Where in a store's own words a banned word was found ('tags': a tag or a cuisine label). */
export type StoreField = 'name' | 'description' | 'tags';
export type StoreWordHit = { prohibitedClass: ProhibitedClass; field: StoreField; term: string };
export type StoreCheck =
  | { state: 'WAITING' | 'APPROVED'; prohibitedClass: ProhibitedClass; field: StoreField; term: string }
  | { state: 'CLEAR' };

/**
 * The store's words judged as an item's are: the name like an item name (a brand as its first word counts:
 * "Ron's Variety", "Banks Hardware"), the description and the labels like prose, a phrase written across them
 * read together. A store is never BANNED by its words, only HELD for a person — a surname or a place is a brand
 * as often as not ("Jameson's Hardware", "Carib Glassworks"), and a person tells the two apart. Banning a store
 * stays Swift's: filing it under a banned category (#54) or suspending it.
 */
export function judgeStoreWords(store: StoreWords): StoreWordHit | null {
  const labels = [...(store.tags ?? []), ...(store.cuisineTypes ?? [])];
  const fields: Array<[StoreField, string | null | undefined, boolean]> = [
    ['name', store.name, true],
    ['description', store.description, false],
    ...labels.map((label): [StoreField, string | null | undefined, boolean] => ['tags', label, false]),
  ];
  const noSoftDrinks = fields.some(([, text]) => !!text && qualifiesSoftDrinks(text));
  for (const [field, text, brandFirst] of fields) {
    const hit = classifyText(text, { noSoftDrinks, brandFirst });
    if (hit) return { ...hit, field };
  }
  const together = fields.map(([, text]) => text).filter(Boolean).join(' . ');
  const hit = classifyText(together, { noSoftDrinks, brandFirst: false, splitWords: false });
  return hit ? { ...hit, field: 'name' } : null;
}
const storeWordsJudge = rememberedJudge(
  (store: StoreWords) => JSON.stringify([store.name, store.description ?? null, (store.tags ?? []).map((tag) => tag ?? null), (store.cuisineTypes ?? []).map((label) => label ?? null)]),
  judgeStoreWords,
);

/** A store's own words judged (see judgeStoreWords), remembered for these exact words (see "Remembered verdicts"). */
export function storeWordHit(store: StoreWords): StoreWordHit | null {
  return storeWordsJudge.judge(store);
}

/** How many answers each judge holds now (for the bound's test). */
export function prohibitedMemoSizes(): { categories: number; items: number; stores: number } {
  return { categories: categoryJudge.size(), items: itemWordsJudge.size(), stores: storeWordsJudge.size() };
}

/** The fingerprint of a store's words a person approved: any change to them brings the check back. */
export function storeWordsHash(store: StoreWords): string {
  const canonical = JSON.stringify([
    normalize(store.name),
    normalize(store.description ?? ''),
    [...(store.tags ?? []), ...(store.cuisineTypes ?? [])].map((t) => normalize(t ?? '')).sort(),
  ]);
  return createHash('sha256').update(`store:${canonical}`).digest('hex');
}

/** The verdict on a store's own words: held until a person approves exactly these words. `hit` may be passed in when
 *  the caller already judged the same words. */
export function checkStore(store: StoreWords & { approvedHash?: string | null }, hit: StoreWordHit | null = storeWordHit(store)): StoreCheck {
  if (!hit) return { state: 'CLEAR' };
  const approved = store.approvedHash != null && store.approvedHash === storeWordsHash(store);
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
/** …and on an item held because its STORE's own words are waiting for a person. */
export const STORE_WAITING_FOR_CHECK = 'Waiting for a quick check of your store';
/** What the partner reads about the store itself while its own words wait for a person. */
export const STORE_WAITING_MESSAGE = 'Your store is waiting for a quick check by Swift: its name, description or tags mention goods Swift doesn\'t carry. Customers can\'t see your store until Swift checks it. If you rename it, the check starts again.';

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
  // [R4] the ordinary half of the expanded list's phrases
  'gold', 'raw', 'rough', 'loose', 'uncut', 'scrap', 'concentrate', 'mineral', 'cracker', 'crackers', 'candle', 'candles',
  'rocket', 'rockets', 'bottle', 'cherry', 'killer', 'spray', 'aluminium', 'aluminum', 'zinc', 'sodium', 'giant', 'ivory',
  'copy', 'first', 'quality', 'gift', 'card', 'cards', 'service', 'services', 'advice', 'office', 'machine', 'machines',
  'doll', 'dolls', 'magazine', 'magazines', 'movie', 'movies', 'video', 'videos', 'dvd', 'dvds', 'pepper',
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
  // [DS1112 S3-1] l33t "rosé" ("R0sé"): the database spells out "rosé" before it reads l33t, so it holds "rose"
  'rose', 'roses',
])].sort();
