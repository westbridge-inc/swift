import type { PrismaClient } from '@prisma/client';

/**
 * [MKT G3/G7] The retail catalogue for the DEMO seed.
 *
 * The Market tab draws from STORE vendors only. Until now the platform had
 * exactly one — City Hardware, five items — and the seed file says so in its
 * own words: *"City Hardware is the only STORE on the platform, so its shelf
 * is the whole catalogue a shopper sees."* Opening the app gave a Market tab
 * holding four hardware items from one store, which is not a marketplace, and
 * G7 now correctly hides the tab entirely at that depth (150 items / 2
 * vendors). A demo that cannot show its own Market tab is not a demo.
 *
 * TWO RULES THIS FILE KEEPS, both from SWIFT_MARKETPLACE:
 *
 * 1. **No invented photography.** §M-D5: *"vertical ground colour + pictogram
 *    + the item's real name, never a grey box, never stock."* Every item here
 *    ships with `imageUrl: null` — the honest name-tile. The existing seed
 *    already NULLED three of City Hardware's five photos because someone
 *    opened them and found a blue-paint photo on white paint and an
 *    incandescent bulb on an LED listing. Adding 150 unverified stock photos
 *    would undo that judgement at thirty times the scale. A real photo enters
 *    this file only after someone has looked at it.
 *
 * 2. **Tagged, not just listed.** §G3: *"ItemDiscoveryCategory rows must
 *    actually exist for retail items — a feed with no tags returns an empty
 *    tab."* The taxonomy shipped 14 RETAIL categories and NOTHING was ever
 *    filed into them: the category rail rendered nothing because
 *    `chips.length > 0` was false. Every item below is tagged, so the chips
 *    the design spec draws (All · Tools & hardware · Apparel · Home) finally
 *    have something to filter.
 *
 * Source is VENDOR: these stand for sellers who categorised their own goods,
 * which is what the machine stages suggestions FOR. The matcher's PENDING
 * suggestions remain the path for everything a vendor has not filed.
 *
 * Idempotent throughout — a re-run adds nothing and stomps nothing.
 */

type Shelf = {
  slug: string;
  name: string;
  description: string;
  address: string;
  lat: number;
  lng: number;
  phone: string;
  tags: string[];
  /** Vendor's own shelf name → the cross-vendor discovery slug it files under. */
  sections: Array<{ name: string; discovery: string; items: Array<[string, number, string]> }>;
};

/** Georgetown retail, priced in whole GYD. Names describe the goods exactly —
 *  the name IS the tile, so an imprecise name is a bad picture. */
const STORES: Shelf[] = [
  {
    slug: 'stabroek-threads',
    name: 'Stabroek Threads',
    description: 'Everyday clothing and school wear, Stabroek Market corner',
    address: '14 Water Street',
    lat: 6.8149, lng: -58.1631, phone: '+5926002101',
    tags: ['Clothing'],
    sections: [
      { name: 'Men', discovery: 'fashion', items: [
        ['Cotton Shirt — White', 5000, 'each'], ['Cotton Shirt — Sky Blue', 5000, 'each'],
        ['Short-Sleeve Polo — Navy', 4200, 'each'], ['Khaki Trousers', 6500, 'each'],
        ['Denim Jeans — Straight', 7800, 'each'], ['Cotton Vest (3-pack)', 3000, 'pack'],
        ['Rain Jacket — Light', 9500, 'each'],
      ] },
      { name: 'Women', discovery: 'fashion', items: [
        ['Cotton Blouse — Cream', 5400, 'each'], ['Wrap Skirt — Printed', 6200, 'each'],
        ['Summer Dress — Floral', 8800, 'each'], ['Leggings — Black', 3400, 'each'],
        ['Cardigan — Light Knit', 7200, 'each'],
      ] },
      { name: 'School wear', discovery: 'fashion', items: [
        ['School Shirt — White (Boys)', 2800, 'each'], ['School Blouse — White (Girls)', 2800, 'each'],
        ['School Trousers — Grey', 3600, 'each'], ['School Skirt — Grey', 3600, 'each'],
        ['School Socks (3-pack)', 1400, 'pack'], ['School Tie — Striped', 1200, 'each'],
      ] },
      { name: 'Footwear', discovery: 'shoes', items: [
        ['Canvas Shoes — Black', 5500, 'pair'], ['School Shoes — Black Leather', 8500, 'pair'],
        ['Rubber Slippers', 1200, 'pair'], ['Sports Trainers', 12000, 'pair'],
      ] },
    ],
  },
  {
    slug: 'regent-home-store',
    name: 'Regent Home Store',
    description: 'Kitchenware, bedding and household goods on Regent Street',
    address: '121 Regent Street',
    lat: 6.8102, lng: -58.1573, phone: '+5926002102',
    tags: ['Home'],
    sections: [
      { name: 'Kitchen', discovery: 'home-kitchen', items: [
        ['Enamel Pot Set (3pc)', 12500, 'set'], ['Non-Stick Frying Pan 24cm', 5800, 'each'],
        ['Pressure Cooker 5L', 18500, 'each'], ['Cutlery Set (24pc)', 6400, 'set'],
        ['Dinner Plates (6pc)', 4800, 'set'], ['Drinking Glasses (6pc)', 3200, 'set'],
        ['Plastic Storage Containers (5pc)', 2900, 'set'], ['Kettle — Stovetop 2L', 4600, 'each'],
        ['Chopping Board — Wood', 1800, 'each'], ['Kitchen Knife Set (5pc)', 7200, 'set'],
      ] },
      { name: 'Bedding', discovery: 'home-kitchen', items: [
        ['Bed Sheet Set — Double', 9500, 'set'], ['Bed Sheet Set — Single', 7000, 'set'],
        ['Pillow — Standard', 2400, 'each'], ['Pillowcase (2-pack)', 1600, 'pack'],
        ['Mosquito Net — Double', 5200, 'each'], ['Bath Towel — Large', 3400, 'each'],
      ] },
      { name: 'Cleaning', discovery: 'home-kitchen', items: [
        ['Floor Mop with Bucket', 4200, 'set'], ['Broom — Soft Bristle', 1500, 'each'],
        ['Laundry Basket', 2800, 'each'], ['Dustpan and Brush', 1100, 'set'],
      ] },
    ],
  },
  {
    slug: 'camp-street-electronics',
    name: 'Camp Street Electronics',
    description: 'Phones, accessories and small electronics',
    address: '52 Camp Street',
    lat: 6.8121, lng: -58.1519, phone: '+5926002103',
    tags: ['Electronics'],
    sections: [
      { name: 'Phone accessories', discovery: 'phone-accessories', items: [
        ['USB-C Charging Cable 1m', 1400, 'each'], ['Lightning Cable 1m', 1600, 'each'],
        ['Wall Charger 20W', 3200, 'each'], ['Power Bank 10000mAh', 8500, 'each'],
        ['Phone Case — Clear', 1800, 'each'], ['Screen Protector — Tempered Glass', 1500, 'each'],
        ['Car Phone Holder', 2400, 'each'], ['Earphones — Wired', 2200, 'pair'],
      ] },
      { name: 'Audio & power', discovery: 'electronics', items: [
        ['Bluetooth Speaker — Portable', 11000, 'each'], ['Earbuds — Wireless', 9500, 'pair'],
        ['Extension Cord 4-Way', 3600, 'each'], ['Surge Protector Strip', 4800, 'each'],
        ['Rechargeable Batteries AA (4-pack)', 3400, 'pack'], ['Torch — Rechargeable LED', 4200, 'each'],
      ] },
    ],
  },
  {
    slug: 'bourda-pharmacy',
    name: 'Bourda Pharmacy & Beauty',
    description: 'Everyday health, personal care and cosmetics near Bourda Market',
    address: '7 Robb Street',
    lat: 6.8135, lng: -58.1552, phone: '+5926002104',
    tags: ['Pharmacy'],
    sections: [
      { name: 'Health', discovery: 'pharmacy', items: [
        ['Paracetamol 500mg (20 tabs)', 900, 'pack'], ['Antiseptic Liquid 250ml', 1600, 'bottle'],
        ['Adhesive Plasters (20pc)', 800, 'pack'], ['Digital Thermometer', 3200, 'each'],
        ['Vitamin C 1000mg (30 tabs)', 2400, 'pack'], ['Rehydration Salts (6 sachets)', 1100, 'pack'],
        ['Cotton Wool 100g', 700, 'pack'], ['Insect Repellent Spray', 2100, 'bottle'],
      ] },
      { name: 'Personal care', discovery: 'beauty', items: [
        ['Bath Soap (4-pack)', 1400, 'pack'], ['Shampoo 400ml', 2600, 'bottle'],
        ['Body Lotion 400ml', 2900, 'bottle'], ['Toothpaste 100ml', 1200, 'each'],
        ['Toothbrush (2-pack)', 900, 'pack'], ['Deodorant Roll-On', 1500, 'each'],
        ['Petroleum Jelly 250ml', 1300, 'each'], ['Sunscreen SPF50 100ml', 4200, 'bottle'],
      ] },
      { name: 'Cosmetics', discovery: 'beauty', items: [
        ['Lipstick — Matte', 2800, 'each'], ['Nail Polish', 1200, 'each'],
        ['Hair Oil 200ml', 2200, 'bottle'], ['Face Cloth (3-pack)', 1000, 'pack'],
      ] },
    ],
  },
  {
    slug: 'demerara-stationers',
    name: 'Demerara Stationers',
    description: 'School and office supplies, books and printing',
    address: '31 Croal Street',
    lat: 6.8156, lng: -58.1607, phone: '+5926002105',
    tags: ['Stationery'],
    sections: [
      { name: 'School supplies', discovery: 'stationery-books', items: [
        ['Exercise Book A4 (80 pages)', 350, 'each'], ['Exercise Books (10-pack)', 3000, 'pack'],
        ['Ballpoint Pens Blue (10-pack)', 1200, 'pack'], ['HB Pencils (12-pack)', 900, 'pack'],
        ['Geometry Set', 1800, 'set'], ['School Bag — Backpack', 7500, 'each'],
        ['Lunch Kit — Insulated', 3400, 'each'], ['Ruler 30cm', 300, 'each'],
        ['Eraser and Sharpener Set', 400, 'set'], ['Coloured Pencils (12-pack)', 1600, 'pack'],
      ] },
      { name: 'Office', discovery: 'stationery-books', items: [
        ['A4 Copy Paper (500 sheets)', 4200, 'ream'], ['Stapler with Staples', 2200, 'each'],
        ['File Folders (10-pack)', 2600, 'pack'], ['Whiteboard Markers (4-pack)', 1800, 'pack'],
        ['Calculator — Desktop', 5400, 'each'], ['Sticky Notes (5-pack)', 1400, 'pack'],
      ] },
      { name: 'Toys & games', discovery: 'toys-games', items: [
        ['Playing Cards', 600, 'pack'], ['Dominoes Set', 2400, 'set'],
        ['Ludo Board Game', 1800, 'each'], ['Skipping Rope', 1200, 'each'],
        ['Colouring Book', 700, 'each'],
      ] },
    ],
  },
  {
    slug: 'kitty-sports-and-auto',
    name: 'Kitty Sports & Auto',
    description: 'Sportswear, fitness gear and everyday car parts',
    address: '9 Alexander Street, Kitty',
    lat: 6.8194, lng: -58.1408, phone: '+5926002106',
    tags: ['Sports'],
    sections: [
      { name: 'Sports', discovery: 'sports', items: [
        ['Football — Size 5', 5200, 'each'], ['Cricket Ball — Leather', 3800, 'each'],
        ['Cricket Bat — Junior', 12500, 'each'], ['Skipping Rope — Weighted', 2600, 'each'],
        ['Dumbbells 5kg (pair)', 9800, 'pair'], ['Yoga Mat', 4600, 'each'],
        ['Water Bottle 1L', 1600, 'each'], ['Sports Socks (3-pack)', 1800, 'pack'],
      ] },
      { name: 'Auto', discovery: 'auto-parts', items: [
        ['Engine Oil 4L — 20W-50', 8500, 'bottle'], ['Oil Filter — Common Fit', 2400, 'each'],
        ['Wiper Blades (pair)', 3600, 'pair'], ['Car Battery Terminal Cleaner', 1400, 'each'],
        ['Jump Leads 2m', 6800, 'set'], ['Tyre Pressure Gauge', 1900, 'each'],
        ['Microfibre Cloths (5-pack)', 1500, 'pack'], ['Car Air Freshener', 700, 'each'],
      ] },
      { name: 'Pets', discovery: 'pets', items: [
        ['Dog Food 2kg — Dry', 4800, 'bag'], ['Cat Food 1kg — Dry', 3600, 'bag'],
        ['Pet Bowl — Stainless', 1400, 'each'], ['Dog Collar — Adjustable', 1800, 'each'],
        ['Pet Shampoo 250ml', 2200, 'bottle'],
      ] },
    ],
  },
  {
    slug: 'bourda-variety',
    name: 'Bourda Variety Store',
    description: 'Gifts, flowers, party goods and everyday odds and ends',
    address: '18 North Road, Bourda',
    lat: 6.8141, lng: -58.1544, phone: '+5926002107',
    tags: ['Variety'],
    sections: [
      { name: 'Gifts & flowers', discovery: 'flowers-gifts', items: [
        ['Gift Wrap Roll', 900, 'roll'], ['Greeting Card', 600, 'each'],
        ['Gift Bag — Medium', 800, 'each'], ['Artificial Flower Bunch', 2400, 'each'],
        ['Scented Candle', 2800, 'each'], ['Photo Frame 6x4', 1800, 'each'],
        ['Ribbon Roll', 500, 'roll'], ['Gift Box — Small', 1100, 'each'],
      ] },
      { name: 'Party', discovery: 'toys-games', items: [
        ['Balloons (20-pack)', 1200, 'pack'], ['Paper Plates (25-pack)', 1400, 'pack'],
        ['Paper Cups (25-pack)', 1100, 'pack'], ['Birthday Candles (12-pack)', 500, 'pack'],
        ['Party Hats (10-pack)', 1000, 'pack'], ['Table Cover — Plastic', 900, 'each'],
        ['Streamers (3-pack)', 800, 'pack'],
      ] },
      { name: 'Household', discovery: 'home-kitchen', items: [
        ['Clothes Pegs (24-pack)', 700, 'pack'], ['Clothes Line 10m', 1500, 'each'],
        ['Bin Bags (20-pack)', 1300, 'pack'], ['Dish Sponge (4-pack)', 800, 'pack'],
        ['Rubber Gloves', 900, 'pair'], ['Bucket 10L', 1600, 'each'],
        ['Mosquito Coils (10-pack)', 1000, 'pack'], ['Matches (10 boxes)', 400, 'pack'],
        ['Batteries D (2-pack)', 1400, 'pack'], ['Padlock 40mm', 2200, 'each'],
      ] },
      { name: 'Kids', discovery: 'toys-games', items: [
        ['Toy Car — Die-cast', 1500, 'each'], ['Building Blocks (60pc)', 4200, 'set'],
        ['Jigsaw Puzzle 100pc', 2200, 'each'], ['Soft Toy — Bear', 3400, 'each'],
        ['Kite', 1200, 'each'], ['Marbles (20-pack)', 600, 'pack'],
        ['Water Pistol', 1800, 'each'], ['Bubble Solution', 700, 'each'],
      ] },
    ],
  },
];

/**
 * Build the retail catalogue. Idempotent: existing vendors/items/tags are left
 * exactly as they are, so a re-run is a no-op and a real vendor edit is never
 * stomped.
 */
export async function seedRetailCatalogue(
  prisma: PrismaClient,
  ownerId: string,
  tenantId = 'swift-default',
): Promise<{ vendors: number; items: number; tags: number; memberships: number }> {
  // The cross-vendor taxonomy must already exist — this files INTO it, it does
  // not invent categories.
  const taxonomy = new Map(
    (await prisma.discoveryCategory.findMany({
      where: { tenantId, vertical: 'RETAIL' },
      select: { id: true, slug: true },
    })).map((c) => [c.slug, c.id]),
  );

  let vendors = 0;
  let items = 0;
  let tags = 0;
  let memberships = 0;

  for (const store of STORES) {
    const vendor = await prisma.vendor.upsert({
      where: { slug: store.slug },
      update: {},
      create: {
        ownerId,
        name: store.name,
        slug: store.slug,
        description: store.description,
        vendorType: 'STORE',
        phone: store.phone,
        addressLine1: store.address,
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: store.lat,
        longitude: store.lng,
        isCurrentlyOpen: true,
        acceptingOrders: true,
        isVerified: true,
        status: 'ACTIVE',
        cuisineTypes: [],
        tags: store.tags,
      },
    });
    vendors += 1;

    /** Has this store claimed its ONE primary category yet?
     *
     *  Not a set of category ids — a single flag, because the rule is per
     *  VENDOR, not per category. Postgres carries it as a partial unique index
     *  that the Prisma schema does not express:
     *
     *    one_primary_discovery_category_per_vendor UNIQUE (vendorId)
     *      WHERE role = 'PRIMARY'
     *
     *  A store is primarily one kind of shop. Everything after its first
     *  category is SECONDARY — the electronics shop that also sells phone
     *  accessories is still an electronics shop. Getting this wrong is silent:
     *  `skipDuplicates` swallows the rejected row, the seed reports success,
     *  and the store is missing from every category rail but its first. */
    let hasPrimary = false;

    const existing = new Set(
      (await prisma.item.findMany({ where: { vendorId: vendor.id }, select: { name: true } })).map((i) => i.name),
    );

    let sortOrder = 0;
    for (const [sectionIndex, section] of store.sections.entries()) {
      const category =
        (await prisma.category.findFirst({ where: { vendorId: vendor.id, name: section.name } })) ??
        (await prisma.category.create({ data: { vendorId: vendor.id, name: section.name, sortOrder: sectionIndex } }));

      const missing = section.items.filter(([name]) => !existing.has(name));
      if (missing.length) {
        await prisma.item.createMany({
          data: missing.map(([name, price, unit]) => ({
            vendorId: vendor.id,
            categoryId: category.id,
            name,
            basePrice: price,
            fulfillment: 'PICKUP' as const,
            unit,
            stockQuantity: 25,
            sortOrder: sortOrder++,
            // [M-D5] No photograph enters this file unopened. The honest
            // name-tile is the law, not a placeholder for a photo we owe.
            imageUrl: null,
            dietaryTags: [],
            allergens: [],
          })),
        });
        items += missing.length;
      }

      // [G3] File the shelf into the cross-vendor taxonomy, or the category
      // rail renders nothing and the tab is a flat list wearing a market's name.
      const discoveryId = taxonomy.get(section.discovery);
      if (discoveryId) {
        const shelfItems = await prisma.item.findMany({
          where: { vendorId: vendor.id, categoryId: category.id },
          select: { id: true },
        });
        for (const item of shelfItems) {
          const created = await prisma.itemDiscoveryCategory.createMany({
            data: [{ tenantId, itemId: item.id, categoryId: discoveryId, source: 'VENDOR' as const }],
            skipDuplicates: true,
          });
          tags += created.count;
        }

        // ...and file the STORE into the same category, which is a separate
        // table and a separate truth. The item tags are what
        // `/market/items?category=` filters on; the CHIPS come from
        // `vendor_discovery_categories`, counted by GET /discovery/categories
        // and then filtered by "law D: no dead taps". Tagging only the items
        // produces a Market tab whose filters work and whose category rail is
        // empty — every chip dropped for having zero vendors behind it. Both
        // rows, or the rail renders nothing.
        //
        // PRIMARY for the store's first shelf in a category, SECONDARY after:
        // a clothing shop that also sells a few bags is a clothing shop.
        const membership = await prisma.vendorDiscoveryCategory.createMany({
          data: [{
            tenantId,
            vendorId: vendor.id,
            categoryId: discoveryId,
            role: hasPrimary ? 'SECONDARY' : 'PRIMARY',
            source: 'VENDOR' as const,
          }],
          skipDuplicates: true,
        });
        if (membership.count > 0 && !hasPrimary) hasPrimary = true;
        memberships += membership.count;
      }
    }
  }

  return { vendors, items, tags, memberships };
}
