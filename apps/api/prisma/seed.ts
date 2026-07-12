import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.warn('Seeding database...');

  // Partial unique index Prisma cannot express: one LIVE booking per item per
  // slot (CANCELLED frees the slot). CI uses `db push`, so it lands here.
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "bookings_item_slot_live_key"
     ON "bookings"("itemId", "slotStart") WHERE "status" <> 'CANCELLED'`,
  );

  // PostGIS + the dispatch candidate index — also here for db push
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS postgis');
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "riders_geo_gist"
     ON "riders" USING GIST (geography(ST_MakePoint("currentLng", "currentLat")))
     WHERE "isOnline" = true AND "currentLat" IS NOT NULL AND "currentLng" IS NOT NULL`,
  );

  // Platform config defaults
  const configs = [
    { key: 'markup_percentage', value: 5 },
    { key: 'delivery_base_fee', value: 500 },
    { key: 'delivery_per_km', value: 200 },
    { key: 'delivery_included_km', value: 2 },
    { key: 'taxi_base_fare', value: 1000 },
    { key: 'taxi_per_km', value: 300 },
    { key: 'taxi_per_minute', value: 50 },
    { key: 'taxi_minimum_fare', value: 1500 },
    { key: 'surge_threshold', value: 0.8 },
    { key: 'surge_max_multiplier', value: 2.0 },
    { key: 'subscription_grace_period_hours', value: 24 },
    { key: 'settlement_cycle_days', value: 7 },
    { key: 'min_rider_rating', value: 4.0 },
    { key: 'max_failed_payment_attempts', value: 3 },
    { key: 'order_auto_reject_minutes', value: 5 },
    { key: 'ride_request_timeout_seconds', value: 15 },
    { key: 'courier_base_fee', value: 1000 },
    { key: 'courier_per_km', value: 300 },
    { key: 'order_free_cancellation_window_minutes', value: 5 },
    { key: 'order_cancel_fee_after_acceptance', value: 500 },
    { key: 'taxi_cancel_fee_before_arrival', value: 500 },
    { key: 'taxi_cancel_fee_after_arrival', value: 1000 },
  ];

  for (const config of configs) {
    await prisma.platformConfig.upsert({
      where: { key: config.key },
      update: { value: config.value },
      create: { key: config.key, value: config.value },
    });
  }

  // Super admin
  await prisma.user.upsert({
    where: { phone: '+5926001000' },
    update: {},
    create: {
      phone: '+5926001000',
      firstName: 'Swift',
      lastName: 'Admin',
      roles: ['SUPER_ADMIN', 'CUSTOMER'],
      activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE',
      isPhoneVerified: true,
      admin: { create: { permissions: ['*'] } },
    },
  });

  // Vendor owner user
  const vendorUser = await prisma.user.upsert({
    where: { phone: '+5926002000' },
    update: {},
    create: {
      phone: '+5926002000',
      firstName: 'Oasis',
      lastName: 'Manager',
      roles: ['VENDOR_OWNER', 'CUSTOMER'],
      activeRole: 'VENDOR_OWNER',
      status: 'ACTIVE',
      isPhoneVerified: true,
      vendorOwner: { create: {} },
    },
  });

  // Create vendor
  const owner = await prisma.vendorOwner.findUnique({ where: { userId: vendorUser.id } });
  if (owner) {
    const vendor = await prisma.vendor.upsert({
      where: { slug: 'oasis-cafe' },
      update: {},
      create: {
        ownerId: owner.id,
        name: 'Oasis Cafe',
        slug: 'oasis-cafe',
        description: 'The finest Guyanese and Caribbean cuisine in Georgetown',
        vendorType: 'RESTAURANT',
        phone: '+5926002001',
        addressLine1: '42 Regent Road',
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: 6.8013,
        longitude: -58.1551,
        isCurrentlyOpen: true,
        acceptingOrders: true,
        isVerified: true,
        status: 'ACTIVE',
        cuisineTypes: ['Guyanese', 'Caribbean', 'Seafood'],
        tags: ['Popular', 'Halal Friendly'],
      },
    });

    // Menu + hours are plain creates — guard so re-seeding doesn't duplicate
    const oasisHasMenu = (await prisma.category.count({ where: { vendorId: vendor.id } })) > 0;
    if (!oasisHasMenu) {
      const popular = await prisma.category.create({
        data: { vendorId: vendor.id, name: 'Popular', sortOrder: 0 },
      });
      await prisma.item.createMany({
        data: [
          { vendorId: vendor.id, categoryId: popular.id, name: 'Pepperpot', description: 'Traditional Guyanese stewed meat with cassareep', basePrice: 2500, isPopular: true, sortOrder: 0, dietaryTags: [], allergens: [] },
          { vendorId: vendor.id, categoryId: popular.id, name: 'Cook-Up Rice', description: 'Rice with black-eye peas, coconut milk, and mixed meats', basePrice: 2000, isPopular: true, sortOrder: 1, dietaryTags: [], allergens: [] },
          { vendorId: vendor.id, categoryId: popular.id, name: 'Fried Rice', description: 'Wok-fried rice with vegetables and protein', basePrice: 1800, isPopular: true, sortOrder: 2, dietaryTags: [], allergens: [] },
          { vendorId: vendor.id, categoryId: popular.id, name: 'Chow Mein', description: 'Stir-fried noodles with vegetables', basePrice: 2000, sortOrder: 3, dietaryTags: ['vegetarian'], allergens: ['gluten'] },
        ],
      });

      const beverages = await prisma.category.create({
        data: { vendorId: vendor.id, name: 'Beverages', sortOrder: 1 },
      });
      await prisma.item.createMany({
        data: [
          { vendorId: vendor.id, categoryId: beverages.id, name: 'Fresh Coconut Water', basePrice: 500, sortOrder: 0, dietaryTags: ['vegan'], allergens: [] },
          { vendorId: vendor.id, categoryId: beverages.id, name: 'Mauby', description: 'Traditional Guyanese bark-brewed drink', basePrice: 400, sortOrder: 1, dietaryTags: ['vegan'], allergens: [] },
        ],
      });

      // Item customization (Uber Eats-style options) so the ItemDetail screen has
      // a real example: a required size + optional extras on Pepperpot.
      const pepperpot = await prisma.item.findFirst({ where: { vendorId: vendor.id, name: 'Pepperpot' } });
      if (pepperpot) {
        const size = await prisma.optionGroup.create({
          data: { itemId: pepperpot.id, name: 'Portion size', isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 0 },
        });
        await prisma.option.createMany({
          data: [
            { optionGroupId: size.id, name: 'Regular', additionalPrice: 0, isDefault: true, sortOrder: 0 },
            { optionGroupId: size.id, name: 'Large', additionalPrice: 800, sortOrder: 1 },
          ],
        });
        const extras = await prisma.optionGroup.create({
          data: { itemId: pepperpot.id, name: 'Add extras', isRequired: false, minSelect: 0, maxSelect: 3, sortOrder: 1 },
        });
        await prisma.option.createMany({
          data: [
            { optionGroupId: extras.id, name: 'Extra cassava', additionalPrice: 400, sortOrder: 0 },
            { optionGroupId: extras.id, name: 'Fried plantain', additionalPrice: 300, sortOrder: 1 },
            { optionGroupId: extras.id, name: 'Extra pepper sauce', additionalPrice: 0, sortOrder: 2 },
          ],
        });
      }

      // Operating hours (open 8am-10pm every day)
      for (let day = 0; day < 7; day++) {
        await prisma.operatingHours.create({
          data: { vendorId: vendor.id, dayOfWeek: day, openTime: '08:00', closeTime: '22:00' },
        });
      }
    }

    // Extra restaurants so the food home/search reads like a populated marketplace
    // (varied cuisines, ratings, ETAs, cover photos). Idempotent via slug upsert.
    const MORE_RESTAURANTS: {
      slug: string; name: string; cuisines: string[]; rating: number; ratings: number; eta: number; cover: string;
      items: { name: string; description: string; price: number }[];
    }[] = [
      { slug: 'royal-roti-hut', name: 'Royal Roti Hut', cuisines: ['Indian', 'Guyanese'], rating: 4.8, ratings: 312, eta: 25, cover: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=600&q=80', items: [{ name: 'Chicken Curry & Roti', description: 'Boneless curry with a soft dhal puri', price: 1800 }, { name: 'Dhal Puri (2)', description: 'Split-pea flatbread', price: 600 }, { name: 'Channa & Aloo', description: 'Spiced chickpeas and potato', price: 1200 }] },
      { slug: 'demerara-grill', name: 'Demerara Grill House', cuisines: ['BBQ', 'Caribbean'], rating: 4.6, ratings: 188, eta: 35, cover: 'https://images.unsplash.com/photo-1529193591184-b1d58069ecdd?w=600&q=80', items: [{ name: 'BBQ Chicken Plate', description: 'Grilled chicken, rice & salad', price: 2200 }, { name: 'Pork Chops', description: 'Char-grilled, garlic butter', price: 2800 }, { name: 'Grilled Snapper', description: 'Whole fish, Creole spice', price: 3200 }] },
      { slug: 'georgetown-pizza-co', name: 'Georgetown Pizza Co.', cuisines: ['Pizza', 'Italian'], rating: 4.5, ratings: 421, eta: 30, cover: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&q=80', items: [{ name: 'Margherita', description: 'Tomato, mozzarella, basil', price: 2600 }, { name: 'Pepperoni', description: 'Loaded pepperoni & cheese', price: 3000 }, { name: 'Garlic Knots (6)', description: 'Buttery, herby', price: 1000 }] },
      { slug: 'spice-route', name: 'Spice Route', cuisines: ['Chinese', 'Asian'], rating: 4.7, ratings: 256, eta: 28, cover: 'https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=600&q=80', items: [{ name: 'Sweet & Sour Chicken', description: 'Crispy, peppers & pineapple', price: 2100 }, { name: 'Beef Lo Mein', description: 'Stir-fried noodles', price: 2300 }, { name: 'Veg Spring Rolls (4)', description: 'Crisp & golden', price: 900 }] },
      { slug: 'sea-breeze-seafood', name: 'Sea Breeze Seafood', cuisines: ['Seafood', 'Caribbean'], rating: 4.9, ratings: 143, eta: 40, cover: 'https://images.unsplash.com/photo-1559737558-2f5a35f4523b?w=600&q=80', items: [{ name: 'Garlic Butter Shrimp', description: 'Sautéed with herbs', price: 3400 }, { name: 'Fish & Bakes', description: 'Fried fish, festival bakes', price: 2400 }, { name: 'Crab Curry', description: 'Rich coconut curry', price: 3600 }] },
      { slug: 'sweet-tooth-bakery', name: 'Sweet Tooth Bakery', cuisines: ['Bakery', 'Desserts'], rating: 4.6, ratings: 209, eta: 20, cover: 'https://images.unsplash.com/photo-1486427944299-d1955d23e34d?w=600&q=80', items: [{ name: 'Pine Tart (3)', description: 'Flaky pastry, pineapple', price: 700 }, { name: 'Black Cake Slice', description: 'Rum-soaked Guyanese classic', price: 1200 }, { name: 'Cheese Roll', description: 'Buttery, savoury', price: 500 }] },
      { slug: 'green-bowl', name: 'Green Bowl', cuisines: ['Healthy', 'Vegetarian'], rating: 4.4, ratings: 97, eta: 22, cover: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=80', items: [{ name: 'Buddha Bowl', description: 'Greens, chickpeas, tahini', price: 2000 }, { name: 'Avocado Toast', description: 'Sourdough, chili flakes', price: 1500 }, { name: 'Fresh Juice', description: 'Cold-pressed daily', price: 800 }] },
    ];
    for (let i = 0; i < MORE_RESTAURANTS.length; i++) {
      const r = MORE_RESTAURANTS[i]!;
      const rv = await prisma.vendor.upsert({
        where: { slug: r.slug },
        update: {},
        create: {
          ownerId: owner.id,
          name: r.name,
          slug: r.slug,
          description: `${r.cuisines.join(' · ')} — Georgetown`,
          vendorType: 'RESTAURANT',
          phone: `+59266030${i + 10}`,
          addressLine1: `${10 + i} Main Street`,
          city: 'Georgetown',
          region: 'Demerara-Mahaica',
          latitude: 6.8013,
          longitude: -58.1551,
          isCurrentlyOpen: true,
          acceptingOrders: true,
          isVerified: true,
          isFeatured: i < 3,
          status: 'ACTIVE',
          averageRating: r.rating,
          totalRatings: r.ratings,
          estimatedPrepTime: r.eta,
          coverImageUrl: r.cover,
          cuisineTypes: r.cuisines,
          tags: [],
        },
      });
      const hasMenu = (await prisma.category.count({ where: { vendorId: rv.id } })) > 0;
      if (!hasMenu) {
        const cat = await prisma.category.create({ data: { vendorId: rv.id, name: 'Popular', sortOrder: 0 } });
        await prisma.item.createMany({
          data: r.items.map((it, idx) => ({
            vendorId: rv.id, categoryId: cat.id, name: it.name, description: it.description,
            basePrice: it.price, isPopular: idx === 0, sortOrder: idx, dietaryTags: [], allergens: [],
          })),
        });
      }
    }

    // One vendor of each remaining locked type (SUPERMARKET, STORE, SERVICE)
    // so every fulfillment kind is exercisable end-to-end.
    const freshMart = await prisma.vendor.upsert({
      where: { slug: 'fresh-mart' },
      update: {},
      create: {
        ownerId: owner.id,
        name: 'Fresh Mart',
        slug: 'fresh-mart',
        description: 'Groceries and household essentials',
        vendorType: 'SUPERMARKET',
        phone: '+5926002002',
        addressLine1: '15 Sheriff Street',
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: 6.8101,
        longitude: -58.1422,
        isCurrentlyOpen: true,
        acceptingOrders: true,
        isVerified: true,
        status: 'ACTIVE',
        cuisineTypes: [],
        tags: ['Groceries'],
      },
    });
    // Aisled like a real mart; re-runs top up missing aisles/items by name.
    {
      const aisle = async (name: string, sortOrder: number) =>
        (await prisma.category.findFirst({ where: { vendorId: freshMart.id, name } })) ??
        prisma.category.create({ data: { vendorId: freshMart.id, name, sortOrder } });
      const produce = await aisle('Produce', 0);
      const grains = await aisle('Rice & Grains', 1);
      const essentials = await aisle('Cooking Essentials', 2);
      const drinks = await aisle('Drinks & Snacks', 3);

      const shelf: Array<{ cat: string; name: string; price: number; unit: string; stock: number }> = [
        { cat: produce.id, name: 'Bananas 1kg', price: 600, unit: 'bunch', stock: 50 },
        { cat: produce.id, name: 'Tomatoes 500g', price: 450, unit: 'pack', stock: 40 },
        { cat: produce.id, name: 'Onions 1kg', price: 500, unit: 'bag', stock: 45 },
        { cat: produce.id, name: 'Avocado', price: 350, unit: 'each', stock: 30 },
        { cat: grains.id, name: 'Basmati Rice 5kg', price: 3500, unit: 'bag', stock: 40 },
        { cat: grains.id, name: 'Parboiled Rice 10kg', price: 5200, unit: 'bag', stock: 25 },
        { cat: grains.id, name: 'All-Purpose Flour 2kg', price: 900, unit: 'bag', stock: 35 },
        { cat: grains.id, name: 'Red Lentils 1kg', price: 800, unit: 'bag', stock: 30 },
        { cat: essentials.id, name: 'Cooking Oil 1L', price: 1200, unit: 'bottle', stock: 60 },
        { cat: essentials.id, name: 'Garam Masala 100g', price: 550, unit: 'jar', stock: 24 },
        { cat: essentials.id, name: 'Brown Sugar 2kg', price: 700, unit: 'bag', stock: 40 },
        { cat: essentials.id, name: 'Sea Salt 1kg', price: 300, unit: 'bag', stock: 50 },
        { cat: drinks.id, name: 'Coconut Water 500ml', price: 400, unit: 'bottle', stock: 60 },
        { cat: drinks.id, name: 'Orange Juice 1L', price: 950, unit: 'carton', stock: 30 },
        { cat: drinks.id, name: 'Plantain Chips 150g', price: 350, unit: 'pack', stock: 48 },
        { cat: drinks.id, name: 'Cream Crackers 200g', price: 420, unit: 'pack', stock: 36 },
      ];
      const have = new Set(
        (await prisma.item.findMany({ where: { vendorId: freshMart.id }, select: { name: true } })).map((i) => i.name),
      );
      const missing = shelf.filter((it) => !have.has(it.name));
      if (missing.length) {
        await prisma.item.createMany({
          data: missing.map((it, idx) => ({
            vendorId: freshMart.id,
            categoryId: it.cat,
            name: it.name,
            basePrice: it.price,
            fulfillment: 'DELIVERY' as const,
            unit: it.unit,
            stockQuantity: it.stock,
            sortOrder: idx,
            dietaryTags: [],
            allergens: [],
          })),
        });
      }
      // Re-home the two original items into their aisles, then drop the old
      // catch-all category once it's empty.
      await prisma.item.updateMany({ where: { vendorId: freshMart.id, name: 'Basmati Rice 5kg' }, data: { categoryId: grains.id } });
      await prisma.item.updateMany({ where: { vendorId: freshMart.id, name: 'Cooking Oil 1L' }, data: { categoryId: essentials.id } });
      const legacy = await prisma.category.findFirst({ where: { vendorId: freshMart.id, name: 'Groceries' } });
      if (legacy && (await prisma.item.count({ where: { categoryId: legacy.id } })) === 0) {
        await prisma.category.delete({ where: { id: legacy.id } });
      }
    }

    const hardwareStore = await prisma.vendor.upsert({
      where: { slug: 'city-hardware' },
      update: {},
      create: {
        ownerId: owner.id,
        name: 'City Hardware',
        slug: 'city-hardware',
        description: 'Tools and building supplies — order ahead, pick up in store',
        vendorType: 'STORE',
        phone: '+5926002003',
        addressLine1: '88 Water Street',
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: 6.8167,
        longitude: -58.1648,
        isCurrentlyOpen: true,
        acceptingOrders: true,
        isVerified: true,
        status: 'ACTIVE',
        cuisineTypes: [],
        tags: ['Hardware'],
      },
    });
    {
      const cat = async (name: string, sortOrder: number) =>
        (await prisma.category.findFirst({ where: { vendorId: hardwareStore.id, name } })) ??
        prisma.category.create({ data: { vendorId: hardwareStore.id, name, sortOrder } });
      const tools = await cat('Tools', 0);
      const homeElec = await cat('Home & Electrical', 1);
      const shelf = [
        { cat: tools.id, name: 'Claw Hammer', price: 2500, unit: 'each', stock: 12 },
        { cat: tools.id, name: 'Screwdriver Set (6pc)', price: 3800, unit: 'set', stock: 10 },
        { cat: tools.id, name: 'Measuring Tape 5m', price: 1500, unit: 'each', stock: 20 },
        { cat: homeElec.id, name: 'Emulsion Paint 4L — White', price: 6500, unit: 'bucket', stock: 8 },
        { cat: homeElec.id, name: 'LED Bulb 9W (2-pack)', price: 1200, unit: 'pack', stock: 30 },
      ];
      const have = new Set(
        (await prisma.item.findMany({ where: { vendorId: hardwareStore.id }, select: { name: true } })).map((i) => i.name),
      );
      const missing = shelf.filter((it) => !have.has(it.name));
      if (missing.length) {
        await prisma.item.createMany({
          data: missing.map((it, idx) => ({
            vendorId: hardwareStore.id,
            categoryId: it.cat,
            name: it.name,
            basePrice: it.price,
            fulfillment: 'PICKUP' as const,
            unit: it.unit,
            stockQuantity: it.stock,
            sortOrder: idx,
            dietaryTags: [],
            allergens: [],
          })),
        });
      }
    }

    const barbershop = await prisma.vendor.upsert({
      where: { slug: 'sharp-cuts' },
      update: {},
      create: {
        ownerId: owner.id,
        name: 'Sharp Cuts Barbershop',
        slug: 'sharp-cuts',
        description: 'Walk-ins welcome, appointments guaranteed',
        vendorType: 'SERVICE',
        phone: '+5926002004',
        addressLine1: '7 Camp Street',
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: 6.8089,
        longitude: -58.1507,
        isCurrentlyOpen: true,
        acceptingOrders: true,
        isVerified: true,
        status: 'ACTIVE',
        cuisineTypes: [],
        tags: ['Barber', 'Grooming'],
      },
    });
    {
      const services =
        (await prisma.category.findFirst({ where: { vendorId: barbershop.id, name: 'Services' } })) ??
        (await prisma.category.create({ data: { vendorId: barbershop.id, name: 'Services', sortOrder: 0 } }));
      const week = [
        { dayOfWeek: 2, start: '09:00', end: '17:00' },
        { dayOfWeek: 3, start: '09:00', end: '17:00' },
        { dayOfWeek: 4, start: '09:00', end: '17:00' },
        { dayOfWeek: 5, start: '09:00', end: '18:00' },
        { dayOfWeek: 6, start: '08:00', end: '18:00' },
      ];
      // The demo menu exercises every where-it-happens mode the editor offers.
      const menu = [
        { name: "Men's Haircut", price: 2000, minutes: 30, mode: 'BOTH', radius: 8 },
        { name: 'Beard Trim', price: 1000, minutes: 15, mode: 'AT_BUSINESS' },
        { name: 'Hot Towel Shave', price: 1500, minutes: 30, mode: 'AT_BUSINESS' },
        { name: 'Home Visit Cut', price: 3500, minutes: 45, mode: 'MOBILE', radius: 10 },
      ] as const;
      for (const [idx, m] of menu.entries()) {
        const bookingConfig = {
          durationMinutes: m.minutes,
          slots: week,
          serviceMode: m.mode,
          ...('radius' in m && m.radius ? { serviceRadiusKm: m.radius } : {}),
        };
        const existing = await prisma.item.findFirst({ where: { vendorId: barbershop.id, name: m.name } });
        if (existing) {
          await prisma.item.update({ where: { id: existing.id }, data: { bookingConfig } });
        } else {
          await prisma.item.create({
            data: {
              vendorId: barbershop.id,
              categoryId: services.id,
              name: m.name,
              basePrice: m.price,
              fulfillment: 'APPOINTMENT',
              bookingConfig,
              sortOrder: idx,
              dietaryTags: [],
              allergens: [],
            },
          });
        }
      }
    }
  }

  // ── Item imagery ──────────────────────────────────────────────────────────
  // Every seeded listing gets a photo that actually matches it (subjects
  // EYE-verified 2026-07-11 — an HTTP 200 alone proved nothing: several IDs
  // resolved to tandoori chicken/guitars/excavators). Free-license Unsplash
  // only, no plus.unsplash.com premium. Without a photo the app falls back to
  // a generic pool and "Pepperpot" renders as cake. updateMany by name heals
  // existing dev DBs on re-run; the imageUrl:null guard never stomps a
  // vendor-uploaded photo.
  const itemImages: Record<string, string> = {
    Pepperpot: '1544025162-d76694265947',
    'Cook-Up Rice': '1516684732162-798a0062be99',
    'Fried Rice': '1603133872878-684f208fb84b',
    'Chow Mein': '1585032226651-759b368d7246',
    'Fresh Coconut Water': '1588413336019-dd5d3beddf55',
    Mauby: '1541544537156-7627a7a4aa1c',
    'Chicken Curry & Roti': '1565557623262-b51c2513a641',
    'Dhal Puri (2)': '1567620905732-2d1ec7ab7445',
    'Channa & Aloo': '1546069901-ba9599a7e63c',
    'BBQ Chicken Plate': '1504674900247-0877df9cc836',
    'Pork Chops': '1608198093002-ad4e005484ec',
    'Grilled Snapper': '1535140728325-a4d3707eee61',
    Margherita: '1565299624946-b28f40a0ae38',
    Pepperoni: '1513104890138-7c749659a591',
    'Garlic Knots (6)': '1482049016688-2d3e1b311543',
    'Sweet & Sour Chicken': '1512058564366-18510be2db19',
    'Beef Lo Mein': '1585032226651-759b368d7246',
    'Veg Spring Rolls (4)': '1546069901-ba9599a7e63c',
    'Garlic Butter Shrimp': '1563379926898-05f4575a45d8',
    'Fish & Bakes': '1535140728325-a4d3707eee61',
    'Crab Curry': '1565557623262-b51c2513a641',
    'Pine Tart (3)': '1565958011703-44f9829ba187',
    'Black Cake Slice': '1486427944299-d1955d23e34d',
    'Cheese Roll': '1567620905732-2d1ec7ab7445',
    'Buddha Bowl': '1512621776951-a57141f2eefd',
    'Avocado Toast': '1482049016688-2d3e1b311543',
    'Fresh Juice': '1613478223719-2ab802602423',
    'Basmati Rice 5kg': '1536304993881-ff6e9eefa2a6',
    'Cooking Oil 1L': '1474979266404-7eaacbcd87c5',
    'Claw Hammer': '1586864387967-d02ef85d93e8',
    "Men's Haircut": '1503951914875-452162b0f3f1',
    'Bananas 1kg': '1571771894821-ce9b6c11b08e',
    'Tomatoes 500g': '1592924357228-91a4daadcfea',
    'Onions 1kg': '1518977956812-cd3dbadaaf31',
    'Avocado': '1523049673857-eb18f1d7b578',
    'Parboiled Rice 10kg': '1586201375761-83865001e31c',
    'All-Purpose Flour 2kg': '1610725664285-7c57e6eeac3f',
    'Red Lentils 1kg': '1614373532201-c40b993f0013',
    'Garam Masala 100g': '1596040033229-a9821ebd058d',
    'Brown Sugar 2kg': '1704079611177-a3a60ce6f975',
    'Sea Salt 1kg': '1518110925495-5fe2fda0442c',
    'Coconut Water 500ml': '1588413336019-dd5d3beddf55',
    'Orange Juice 1L': '1613478223719-2ab802602423',
    'Plantain Chips 150g': '1762884601729-0eeeafbdfb8a',
    'Cream Crackers 200g': '1691332663036-6f196621c2ee',
    'Screwdriver Set (6pc)': '1663638964046-4b576e739a3a',
    'Measuring Tape 5m': '1703756291638-b1774ae3c186',
    'Emulsion Paint 4L — White': '1562259949-e8e7689d7828',
    'LED Bulb 9W (2-pack)': '1529310399831-ed472b81d589',
    'Beard Trim': '1621605815971-fbc98d665033',
    'Hot Towel Shave': '1599351431202-1e0f0137899a',
    'Home Visit Cut': '1599351431613-18ef1fdd27e1',
  };
  for (const [name, photo] of Object.entries(itemImages)) {
    await prisma.item.updateMany({
      where: { name, imageUrl: null },
      data: { imageUrl: `https://images.unsplash.com/photo-${photo}?w=600&q=80` },
    });
  }

  // Storefront covers for the demo stores. Without one, RestaurantScreen's hero
  // falls back to a type-pooled hash pick — the barbershop drew a clothing
  // store. Null-guarded like item photos: a real vendor upload is never stomped.
  const vendorCovers: Record<string, string> = {
    'fresh-mart': '1604719312566-8912e9227c6a',
    'city-hardware': '1631856954655-966f97d809de',
    'sharp-cuts': '1610475680335-dafab5475150',
  };
  for (const [slug, photo] of Object.entries(vendorCovers)) {
    await prisma.vendor.updateMany({
      where: { slug, coverImageUrl: null },
      data: { coverImageUrl: `https://images.unsplash.com/photo-${photo}?w=1200&q=80` },
    });
  }

  // Customer
  await prisma.user.upsert({
    where: { phone: '+5926003000' },
    update: {},
    create: {
      phone: '+5926003000',
      firstName: 'Test',
      lastName: 'Customer',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      status: 'ACTIVE',
      isPhoneVerified: true,
      customer: { create: {} },
      addresses: {
        create: { label: 'Home', addressLine1: '123 Main Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8045, longitude: -58.1553, isDefault: true },
      },
    },
  });

  // Rider
  await prisma.user.upsert({
    where: { phone: '+5926004000' },
    update: {},
    create: {
      phone: '+5926004000',
      firstName: 'Rahul',
      lastName: 'Singh',
      roles: ['RIDER', 'CUSTOMER'],
      activeRole: 'RIDER',
      status: 'ACTIVE',
      isPhoneVerified: true,
      rider: {
        create: {
          riderType: 'BOTH',
          vehicleType: 'MOTORCYCLE',
          vehicleMake: 'Honda',
          vehicleModel: 'Wave',
          vehicleYear: 2023,
          vehicleColor: 'Red',
          licensePlate: 'GY-1234',
          documentsVerified: true,
        },
      },
    },
  });

  // Taxi drivers spread across tiers so Economy/Comfort/XL is demoable (verified,
  // tier-tagged, in Georgetown Central). Seeded OFFLINE — they go online from the
  // driver app; this also keeps dispatch tests deterministic (an always-online
  // seed fleet would compete with each test's own freshly-created driver).
  const demoDrivers = [
    { phone: '+5926005001', firstName: 'Anil', rideClass: 'ECONOMY' as const, make: 'Toyota', model: 'Allion', color: 'Silver', plate: 'HC-5001', capacity: 4 },
    { phone: '+5926005002', firstName: 'Marcus', rideClass: 'COMFORT' as const, make: 'Toyota', model: 'Premio', color: 'Black', plate: 'HC-5002', capacity: 4 },
    { phone: '+5926005003', firstName: 'Deon', rideClass: 'XL' as const, make: 'Toyota', model: 'Noah', color: 'Pearl White', plate: 'HC-5003', capacity: 6 },
  ];
  for (const d of demoDrivers) {
    await prisma.user.upsert({
      where: { phone: d.phone },
      update: { driver: { update: { rideClass: d.rideClass, isOnline: false, isAvailable: true } } },
      create: {
        phone: d.phone,
        firstName: d.firstName,
        lastName: 'Driver',
        roles: ['DRIVER', 'CUSTOMER'],
        activeRole: 'DRIVER',
        status: 'ACTIVE',
        isPhoneVerified: true,
        driver: {
          create: {
            vehicleMake: d.make,
            vehicleModel: d.model,
            vehicleYear: 2021,
            vehicleColor: d.color,
            licensePlate: d.plate,
            vehicleCapacity: d.capacity,
            rideClass: d.rideClass,
            driverLicenseUrl: 'storage://seed/dl.jpg',
            vehicleInsuranceUrl: 'storage://seed/ins.jpg',
            documentsVerified: true,
            documentsVerifiedAt: new Date(),
            isOnline: false,
            isAvailable: true,
            currentLat: 6.81,
            currentLng: -58.155,
            lastLocationUpdate: new Date(),
            // go-online requires a live subscription for drivers (no missing-row
            // grandfathering, unlike riders) — without this the Comfort/XL demo
            // fleet can never come online (found in the platform audit).
            subscription: {
              create: {
                type: 'TAXI_DRIVER',
                status: 'TRIAL',
                weeklyRate: 12000,
                currentPeriodStart: new Date(),
                currentPeriodEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                nextBillingDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                isTrialActive: true,
                trialEndDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
              },
            },
          },
        },
      },
    });
  }

  // Universal signup selfie (master plan §3): seeded QA accounts get a profile
  // photo so demo flows don't dead-end at the selfie gate. Real signups capture
  // theirs in-app with the camera. Deterministic per-phone portrait for dev.
  const selfieless = await prisma.user.findMany({
    where: { phone: { startsWith: '+592600' }, selfieCapturedAt: null },
    select: { id: true, phone: true },
  });
  for (const u of selfieless) {
    await prisma.user.update({
      where: { id: u.id },
      data: {
        avatar: `https://i.pravatar.cc/300?u=${encodeURIComponent(u.phone)}`,
        selfieCapturedAt: new Date(),
      },
    });
  }

  // Georgetown zone
  await prisma.zone.upsert({
    where: { id: 'georgetown-central' },
    update: {},
    create: {
      id: 'georgetown-central',
      name: 'Georgetown Central',
      description: 'Central Georgetown delivery zone',
      boundary: { type: 'Polygon', coordinates: [[[-58.18, 6.78], [-58.13, 6.78], [-58.13, 6.83], [-58.18, 6.83], [-58.18, 6.78]]] },
      deliveryBaseFee: 500,
      deliveryPerKm: 200,
    },
  });

  // Approved verification documents for the seeded demo accounts so every
  // gate (listing / go-online / hire-class insurance) passes out of the box.
  // Idempotent per docType: reseeding after a checklist grows tops up ONLY the
  // missing documents instead of skipping the whole account.
  async function ensureApprovedDocs(
    userId: string,
    role: 'VENDOR_OWNER' | 'MOVER',
    docTypes: string[],
    extraByDocType: Record<string, object> = {},
  ) {
    const have = await prisma.verificationDocument.findMany({
      where: { userId, docType: { in: docTypes }, status: 'APPROVED' },
      select: { docType: true },
    });
    const haveSet = new Set(have.map((d) => d.docType));
    const missing = docTypes.filter((d) => !haveSet.has(d));
    if (missing.length === 0) return;
    await prisma.verificationDocument.createMany({
      data: missing.map((docType) => ({
        userId,
        role,
        docType,
        fileUrl: `storage://seed/${docType}.jpg`,
        status: 'APPROVED' as const,
        reviewedBy: 'seed',
        reviewedAt: new Date(),
        ...(extraByDocType[docType] ?? {}),
      })),
    });
  }

  // The demo owner runs every vendor type — union of all four checklists.
  const seededVendorUser = await prisma.user.findUnique({ where: { phone: '+5926002000' } });
  if (seededVendorUser) {
    await ensureApprovedDocs(seededVendorUser.id, 'VENDOR_OWNER', [
      'owner_national_id', 'business_registration', 'tin_certificate',
      'gra_restaurant_licence', 'food_handler_cert', 'storefront_photo', 'police_clearance',
    ]);
  }
  const seededRiderUser = await prisma.user.findUnique({ where: { phone: '+5926004000' } });
  if (seededRiderUser) {
    await ensureApprovedDocs(seededRiderUser.id, 'MOVER', [
      'national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance',
    ]);
  }
  // Demo taxi drivers: the full CAR checklist, with the insurance row carrying
  // the manually-confirmed HIRE class the live-operation gate demands.
  const hireInsurance = {
    vehicle_insurance: {
      insurerName: 'Demerara Mutual (demo)',
      policyNumber: 'HC-DEMO',
      coverageClass: 'HIRE' as const,
      hireClassConfirmed: true,
      plateCrossChecked: true,
    },
  };
  for (const d of demoDrivers) {
    const drv = await prisma.user.findUnique({ where: { phone: d.phone } });
    if (!drv) continue;
    await ensureApprovedDocs(drv.id, 'MOVER', [
      'national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration',
      'vehicle_insurance', 'hire_car_permit', 'vehicle_plate_photo', 'vehicle_exterior_photo', 'fitness_cert',
    ], hireInsurance);
  }

  // Guyana CountryConfig — the single source for currency, ID-gate, tiers,
  // and document checklists. Adding a country = adding a row, not code.
  const guyanaTiers = { mover: 12000, smallVendor: 20000, largeVendor: 30000 };
  const guyanaChecklists = {
    // Every mover (incl. bicycle couriers) proves identity AND character —
    // couriers handle cash and walk up to homes, so the Police Clearance
    // (Certificate of Character) applies to ALL of them (master plan §3.2:
    // only licence/registration/insurance are motorized-only).
    MOVER: ['national_id', 'police_clearance'],
    // Motor vehicles (motorcycle + car) add licence, registration, insurance.
    MOVER_MOTOR: ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'],
    // Taxi drivers carry passengers — heaviest checklist: occupational permit,
    // H-plate photo, exterior car photo with the H plate + corporate-yellow
    // paint visible (master plan §3.1), and an annual fitness certificate.
    MOVER_TAXI_EXTRA: ['hire_car_permit', 'vehicle_plate_photo', 'vehicle_exterior_photo', 'fitness_cert'],
    // Commerce operators (master plan §3.3–3.5): registration + TIN for every
    // business; restaurants add the GRA eating-house licence + food handler
    // cert; every storefront photographs its premises (shown to customers).
    RESTAURANT: ['owner_national_id', 'business_registration', 'tin_certificate', 'gra_restaurant_licence', 'food_handler_cert', 'storefront_photo'],
    SUPERMARKET: ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'],
    STORE: ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'],
    // SERVICE-type vendor owners meet the same bar as individual providers
    // (§3.6): identity + police clearance (they enter customers' homes).
    SERVICE: ['owner_national_id', 'police_clearance'],
    // Hire-a-professional providers (§4.6): ID + police clearance are mandatory.
    SERVICE_PROVIDER: ['national_id', 'police_clearance'],
    CUSTOMER_L2: ['national_id', 'selfie'],
  };
  const guyanaTaxiRates = { base: 1000, perKm: 300, perMin: 25, minimum: 1500 };
  // Per-tier multipliers on the base (Economy) fare — country-independent.
  const taxiClassRates = { ECONOMY: 1.0, COMFORT: 1.35, XL: 1.8 };
  const guyanaCashRules = {
    maxClaimsPerRiderPerMonth: 3,
    strikeRestrictThreshold: 2,
    strikeBanThreshold: 4,
    l3MinPaidOrders: 20,
    l3MinAccountAgeDays: 30,
    outlierMultiplier: 3,
  };
  const guyanaRegion = {
    taxiCredentialName: 'Hire Car Licence',
    insuranceClassName: 'Hire',
    verificationSources: ['ID Analyzer', 'GESW', 'GEI registry', 'Police Clearance'],
    regulatoryNotes: 'Data Protection Act 2023 in force; the Nevis entity requires a Guyana local representative.',
    locale: 'en-GY',
  };
  await prisma.countryConfig.upsert({
    where: { code: 'GY' },
    update: {
      isActive: true,
      usdExchangeRate: 209.0,
      idGateThresholdUsd: 50,
      floatL1: 8000,
      floatL2: 20000,
      floatL3: 40000,
      subscriptionTiers: guyanaTiers,
      documentChecklists: guyanaChecklists,
      taxiRates: guyanaTaxiRates,
      taxiClassRates,
      cashRules: guyanaCashRules,
      ...guyanaRegion,
    },
    create: {
      code: 'GY',
      name: 'Guyana',
      currencyCode: 'GYD',
      currencySymbol: '$',
      usdExchangeRate: 209.0,
      idGateThresholdUsd: 50,
      floatL1: 8000,
      floatL2: 20000,
      floatL3: 40000,
      subscriptionTiers: guyanaTiers,
      documentChecklists: guyanaChecklists,
      taxiRates: guyanaTaxiRates,
      taxiClassRates,
      cashRules: guyanaCashRules,
      ...guyanaRegion,
      isActive: true,
    },
  });

  // ── Additional CARIBBEAN markets (multi-country foundation) ──────────────────
  // FACTUAL (Jun 2026): code/name/currency/symbol/usdExchangeRate are real; BBD/BSD/
  // BZD/XCD are hard USD pegs. DEFAULTS to refine per market with local business/legal
  // input: subscription tiers + taxi rates are USD-pegged off Guyana's; documentChecklists
  // and cashRules reuse Guyana's as a template. (Dial codes live in the /auth/countries map.)
  const USD = { mover: 12000 / 209, smallVendor: 20000 / 209, largeVendor: 30000 / 209 };
  const USD_TAXI = { base: 1000 / 209, perKm: 300 / 209, perMin: 25 / 209, minimum: 1500 / 209 };
  // D.3 float limits, USD-pegged off Guyana's (L1 8000 / L2 20000 / L3 40000 GYD).
  const USD_FLOAT = { l1: 8000 / 209, l2: 20000 / 209, l3: 40000 / 209 };
  const niceRound = (n: number) => {
    if (n >= 1000) return Math.round(n / 100) * 100;
    if (n >= 100) return Math.round(n / 10) * 10;
    if (n >= 10) return Math.round(n);
    return Math.round(n * 100) / 100;
  };
  const CARIBBEAN: { code: string; name: string; currencyCode: string; currencySymbol: string; rate: number; locale: string }[] = [
    { code: 'TT', name: 'Trinidad & Tobago', currencyCode: 'TTD', currencySymbol: 'TT$', rate: 6.77, locale: 'en-TT' },
    { code: 'JM', name: 'Jamaica', currencyCode: 'JMD', currencySymbol: 'J$', rate: 158, locale: 'en-JM' },
    { code: 'BB', name: 'Barbados', currencyCode: 'BBD', currencySymbol: 'Bds$', rate: 2.0, locale: 'en-BB' },
    { code: 'BS', name: 'Bahamas', currencyCode: 'BSD', currencySymbol: 'B$', rate: 1.0, locale: 'en-BS' },
    { code: 'SR', name: 'Suriname', currencyCode: 'SRD', currencySymbol: 'SRD', rate: 38, locale: 'nl-SR' },
    { code: 'BZ', name: 'Belize', currencyCode: 'BZD', currencySymbol: 'BZ$', rate: 2.0, locale: 'en-BZ' },
    { code: 'GD', name: 'Grenada', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-GD' },
    { code: 'LC', name: 'Saint Lucia', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-LC' },
    { code: 'AG', name: 'Antigua & Barbuda', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-AG' },
    { code: 'VC', name: 'Saint Vincent & the Grenadines', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-VC' },
    { code: 'KN', name: 'Saint Kitts & Nevis', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-KN' },
    { code: 'DM', name: 'Dominica', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-DM' },
  ];
  for (const c of CARIBBEAN) {
    const data = {
      name: c.name,
      currencyCode: c.currencyCode,
      currencySymbol: c.currencySymbol,
      usdExchangeRate: c.rate,
      idGateThresholdUsd: 50,
      floatL1: niceRound(USD_FLOAT.l1 * c.rate),
      floatL2: niceRound(USD_FLOAT.l2 * c.rate),
      floatL3: niceRound(USD_FLOAT.l3 * c.rate),
      subscriptionTiers: {
        mover: niceRound(USD.mover * c.rate),
        smallVendor: niceRound(USD.smallVendor * c.rate),
        largeVendor: niceRound(USD.largeVendor * c.rate),
      },
      documentChecklists: guyanaChecklists,
      taxiRates: {
        base: niceRound(USD_TAXI.base * c.rate),
        perKm: niceRound(USD_TAXI.perKm * c.rate),
        perMin: niceRound(USD_TAXI.perMin * c.rate),
        minimum: niceRound(USD_TAXI.minimum * c.rate),
      },
      taxiClassRates,
      cashRules: guyanaCashRules,
      verificationSources: ['ID Analyzer'],
      regulatoryNotes:
        'Tiers and taxi rates are USD-pegged defaults; document checklist mirrors Guyana. Refine with local business/legal input before launch.',
      locale: c.locale,
      isActive: false, // launch market = Guyana; others appear as "coming soon" until ops go live
    };
    await prisma.countryConfig.upsert({ where: { code: c.code }, update: data, create: { code: c.code, ...data } });
  }

  // Second zone + one zone-to-zone fixed fare so the table-hit path is live
  await prisma.zone.upsert({
    where: { id: 'georgetown-south' },
    update: {},
    create: {
      id: 'georgetown-south',
      name: 'Georgetown South',
      description: 'South Georgetown taxi zone',
      boundary: { type: 'Polygon', coordinates: [[[-58.18, 6.73], [-58.13, 6.73], [-58.13, 6.78], [-58.18, 6.78], [-58.18, 6.73]]] },
    },
  });
  const zoneFareExists = await prisma.zoneFare.findFirst({
    where: { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south' },
  });
  if (!zoneFareExists) {
    await prisma.zoneFare.createMany({
      data: [
        { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south', fare: 2000 },
        { fromZoneId: 'georgetown-south', toZoneId: 'georgetown-central', fare: 2000 },
      ],
    });
  }

  // D.3 — backfill every rider's float limit from their trust level + country,
  // so existing riders pick up limits after the float-gate migration.
  const allRiders = await prisma.rider.findMany({
    select: { id: true, user: { select: { trustLevel: true, countryCode: true } } },
  });
  for (const r of allRiders) {
    const cc = await prisma.countryConfig.findUnique({
      where: { code: r.user.countryCode },
      select: { floatL1: true, floatL2: true, floatL3: true },
    });
    if (!cc) continue;
    const limit = r.user.trustLevel === 'L3' ? cc.floatL3 : r.user.trustLevel === 'L2' ? cc.floatL2 : cc.floatL1;
    await prisma.rider.update({ where: { id: r.id }, data: { floatLimit: limit } });
  }

  console.warn('Seed complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
