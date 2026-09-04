import { PrismaClient } from '@prisma/client';
import { seedPlatformSpine, guyanaTiers } from './seed-platform';
import { assertSafeToSeedDemo, ensureEphemeralIdentity } from '../src/utils/seed-guard';
import { seedRetailCatalogue } from '../src/modules/market/retail-catalogue.seed';

const prisma = new PrismaClient();

async function main() {
  await assertSafeToSeedDemo(prisma);
  // [R048-005] an empty development/test database declares itself ephemeral so every plan can bind to it
  await ensureEphemeralIdentity(prisma);
  console.warn('Seeding database...');

  // Platform SPINE (tenant, DB objects db-push can't express, config
  // defaults, CountryConfig, launch zones) — the single source, shared with
  // the prod seed (seed-production.ts). Demo accounts below layer on top.
  await seedPlatformSpine(prisma);

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
      syntheticRunId: 'seed-demo', // [SCR-002] synthetic, forever
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
      syntheticRunId: 'seed-demo', // [SCR-002] synthetic, forever
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
    'Fried Rice': '1603133872878-684f208fb84b',
    'Chow Mein': '1585032226651-759b368d7246',
    'Fresh Coconut Water': '1588413336019-dd5d3beddf55',
    'Chicken Curry & Roti': '1565557623262-b51c2513a641',
    'Channa & Aloo': '1546069901-ba9599a7e63c',
    'BBQ Chicken Plate': '1504674900247-0877df9cc836',
    Margherita: '1565299624946-b28f40a0ae38',
    Pepperoni: '1513104890138-7c749659a591',
    'Sweet & Sour Chicken': '1512058564366-18510be2db19',
    'Beef Lo Mein': '1585032226651-759b368d7246',
    'Garlic Butter Shrimp': '1563379926898-05f4575a45d8',
    'Crab Curry': '1565557623262-b51c2513a641',
    'Pine Tart (3)': '1565958011703-44f9829ba187',
    'Black Cake Slice': '1486427944299-d1955d23e34d',
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
    // NOTE ON `Measuring Tape 5m` (kept): the photo is a Stanley PowerLock
    // 5m/16' — the right goods, at the right length, but a BRANDED product
    // standing in for a generic listing. That is a weaker problem than a wrong
    // product and a real one on a live marketplace, where a shopper reads the
    // brand as part of the offer. Registered for the founder rather than
    // decided here; demo data showing a real tape measure is not a lie about
    // what the item is.
    'Measuring Tape 5m': '1703756291638-b1774ae3c186',
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

  // [F-264] Nine of these were flatly the wrong food, verified by downloading
  // every seeded photo and looking at it: Mauby (a Guyanese bark-brewed drink)
  // was a CHEESEBURGER, Cook-Up Rice was Japanese white rice with miso soup,
  // Pork Chops was a basket of baguettes, Grilled Snapper and Fish & Bakes
  // shared one photo of a table of pastries, Cheese Roll and Dhal Puri shared
  // a stack of syrup pancakes, Garlic Knots was avocado toast, Veg Spring
  // Rolls was a buddha bowl.
  //
  // On a Guyanese marketplace that is not a cosmetic slip. The customer buys
  // from the picture, so the wrong picture misrepresents the goods — and it is
  // corrosive besides: once ANY photo might be invented, the real ones stop
  // being evidence. It is also precisely why the app "looks fake" to anyone
  // who knows the food.
  //
  // Removing them from the map above is not enough — dev databases already
  // hold the bad URL — so they are actively nulled here and the honest
  // PhotoPlaceholder names the dish instead. A verified photograph can be
  // added later; a wrong one cannot be un-seen.
  // [MKT] THE RETAIL PASS — F-264 was a FOOD pass, and it stopped there.
  //
  // Nine restaurant dishes were checked by opening the photographs; the STORE's
  // stock never was. That mattered less while the Market tab drew placeholders
  // for everything. It stopped mattering less the moment the card started
  // rendering `imageUrl`, because these five items ARE the Market tab — City
  // Hardware is the only STORE on the platform, so its shelf is the whole
  // catalogue a shopper sees.
  //
  // Same method as F-264: download each one and look at it. Three of five
  // misrepresent the goods, and each fails on the exact attribute the item
  // name promises:
  //
  //   Screwdriver Set (6pc)      ONE flat-head screwdriver. The listing sells
  //                              six; the picture shows one.
  //   Emulsion Paint 4L — White  A roller spreading BLUE paint across a wall.
  //                              No tin in frame at all. Colour is the only
  //                              attribute in that item's name.
  //   LED Bulb 9W (2-pack)       A single glowing INCANDESCENT bulb, tungsten
  //                              filament clearly lit — a photograph of the
  //                              technology this product replaces. Also one
  //                              bulb, not two.
  //
  //   Claw Hammer                a claw hammer. Correct; kept.
  //   Measuring Tape 5m          a 5m tape measure. Correct goods; see the
  //                              brand note on the map above.
  //
  // A customer buying paint chooses by colour and a customer buying LEDs is
  // choosing NOT to buy a filament bulb. These are the F-264 defect exactly,
  // on the tab the founder is most likely to open.
  const UNVERIFIED_PHOTOS = [
    'Mauby', 'Cook-Up Rice', 'Pork Chops', 'Grilled Snapper', 'Fish & Bakes',
    'Cheese Roll', 'Dhal Puri (2)', 'Garlic Knots (6)', 'Veg Spring Rolls (4)',
    'Screwdriver Set (6pc)', 'Emulsion Paint 4L — White', 'LED Bulb 9W (2-pack)',
  ];
  await prisma.item.updateMany({
    where: { name: { in: UNVERIFIED_PHOTOS }, imageUrl: { startsWith: 'https://images.unsplash.com/' } },
    data: { imageUrl: null },
  });

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
      syntheticRunId: 'seed-demo', // [SCR-002] synthetic, forever
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
      syntheticRunId: 'seed-demo', // [SCR-002] synthetic, forever
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
      syntheticRunId: 'seed-demo', // [SCR-002] synthetic, forever
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
                weeklyRate: guyanaTiers.mover,
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

  // [MKT G3/G7] The retail catalogue.
  //
  // The Market tab draws from STORE vendors, and the platform had exactly one
  // — City Hardware, five items — which the note above already calls "the
  // whole catalogue a shopper sees". G7 now hides the tab entirely below 150
  // items / 2 vendors, which is the correct behaviour and leaves the demo
  // unable to show its own Market tab. This is the other half: seven more
  // Georgetown stores, every item filed into the RETAIL taxonomy that shipped
  // empty, and every photo NULL per M-D5 — the honest name-tile, never stock
  // imagery nobody has looked at.
  // The cross-vendor taxonomy is seeded at API BOOT (server.ts), not here, so
  // a database seeded before the API has ever started has no categories at
  // all — and the retail pass below files items INTO that taxonomy. Run it
  // first and the seed stops depending on boot order; it is idempotent, so
  // this is a no-op wherever the API got there first.
  const { seedDiscoveryTaxonomy } = await import('../src/modules/discovery/taxonomy.seed');
  const taxonomy = await seedDiscoveryTaxonomy(prisma);
  console.warn(`Discovery taxonomy: ${taxonomy.created} categories created`);

  // Vendor.ownerId references VendorOwner, not User — the same row City
  // Hardware and every other demo storefront already hangs off.
  const marketUser = await prisma.user.findUniqueOrThrow({ where: { phone: '+5926002000' }, select: { id: true } });
  const marketOwner = await prisma.vendorOwner.findUniqueOrThrow({ where: { userId: marketUser.id }, select: { id: true } });
  const retail = await seedRetailCatalogue(prisma, marketOwner.id);
  console.warn(`Retail catalogue: ${retail.vendors} stores, ${retail.items} items, ${retail.tags} item tags, ${retail.memberships} store categories`);

  // [CAT-G] Turn the category rail ON for the demo.
  //
  // `GET /discovery/categories` is gated on PlatformConfig
  // CATEGORY_DISCOVERY_ENABLED, which defaults to false and which NOTHING has
  // ever set — not the spine, not a migration, not a script. The rail has
  // therefore been dark in every database that exists: the flag returns
  // `{ enabled: false, categories: [] }` and the client renders the pre-rail
  // Home, pixel-identical, exactly as CAT-G designed the kill-switch to
  // behave. Nothing looked broken, because the fallback is deliberately
  // invisible.
  //
  // Only the DEMO seed flips it. The kill-switch is real and a production
  // operator's call to make; a demo that cannot show its own category rail is
  // not a demo. It goes here rather than in seed-platform.ts for exactly that
  // reason — the spine is shared with seed-production.ts.
  await prisma.platformConfig.upsert({
    where: { key: 'CATEGORY_DISCOVERY_ENABLED' },
    create: { key: 'CATEGORY_DISCOVERY_ENABLED', value: true },
    update: { value: true },
  });
  console.warn('Category discovery rail: enabled for demo');

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
