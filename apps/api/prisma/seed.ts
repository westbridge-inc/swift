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

  // PostGIS + the dispatch candidate index (Step 8) — also here for db push
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
    if ((await prisma.category.count({ where: { vendorId: freshMart.id } })) === 0) {
      const groceries = await prisma.category.create({
        data: { vendorId: freshMart.id, name: 'Groceries', sortOrder: 0 },
      });
      await prisma.item.createMany({
        data: [
          { vendorId: freshMart.id, categoryId: groceries.id, name: 'Basmati Rice 5kg', basePrice: 3500, fulfillment: 'DELIVERY', unit: 'bag', stockQuantity: 40, sortOrder: 0, dietaryTags: [], allergens: [] },
          { vendorId: freshMart.id, categoryId: groceries.id, name: 'Cooking Oil 1L', basePrice: 1200, fulfillment: 'DELIVERY', unit: 'bottle', stockQuantity: 60, sortOrder: 1, dietaryTags: [], allergens: [] },
        ],
      });
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
    if ((await prisma.category.count({ where: { vendorId: hardwareStore.id } })) === 0) {
      const tools = await prisma.category.create({
        data: { vendorId: hardwareStore.id, name: 'Tools', sortOrder: 0 },
      });
      await prisma.item.create({
        data: { vendorId: hardwareStore.id, categoryId: tools.id, name: 'Claw Hammer', basePrice: 2500, fulfillment: 'PICKUP', stockQuantity: 12, sortOrder: 0, dietaryTags: [], allergens: [] },
      });
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
    if ((await prisma.category.count({ where: { vendorId: barbershop.id } })) === 0) {
      const services = await prisma.category.create({
        data: { vendorId: barbershop.id, name: 'Services', sortOrder: 0 },
      });
      await prisma.item.create({
        data: {
          vendorId: barbershop.id,
          categoryId: services.id,
          name: "Men's Haircut",
          basePrice: 2000,
          fulfillment: 'APPOINTMENT',
          bookingConfig: {
            durationMinutes: 30,
            slots: [
              { dayOfWeek: 2, start: '09:00', end: '17:00' },
              { dayOfWeek: 3, start: '09:00', end: '17:00' },
              { dayOfWeek: 4, start: '09:00', end: '17:00' },
              { dayOfWeek: 5, start: '09:00', end: '18:00' },
              { dayOfWeek: 6, start: '08:00', end: '18:00' },
            ],
          },
          sortOrder: 0,
          dietaryTags: [],
          allergens: [],
        },
      });
    }
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

  // Approved verification documents for the seeded vendor owner and rider so
  // the Step 4 gates (listing / go-online) pass for the demo accounts.
  const seededVendorUser = await prisma.user.findUnique({ where: { phone: '+5926002000' } });
  if (seededVendorUser) {
    const ownerDocs = ['owner_national_id', 'business_registration', 'food_handler_cert'];
    const existing = await prisma.verificationDocument.count({
      where: { userId: seededVendorUser.id, docType: { in: ownerDocs } },
    });
    if (existing === 0) {
      await prisma.verificationDocument.createMany({
        data: ownerDocs.map((docType) => ({
          userId: seededVendorUser.id,
          role: 'VENDOR_OWNER' as const,
          docType,
          fileUrl: `storage://seed/${docType}.jpg`,
          status: 'APPROVED' as const,
          reviewedBy: 'seed',
          reviewedAt: new Date(),
        })),
      });
    }
  }
  const seededRiderUser = await prisma.user.findUnique({ where: { phone: '+5926004000' } });
  if (seededRiderUser) {
    const moverDocs = ['national_id', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'];
    const existing = await prisma.verificationDocument.count({
      where: { userId: seededRiderUser.id, docType: { in: moverDocs } },
    });
    if (existing === 0) {
      await prisma.verificationDocument.createMany({
        data: moverDocs.map((docType) => ({
          userId: seededRiderUser.id,
          role: 'MOVER' as const,
          docType,
          fileUrl: `storage://seed/${docType}.jpg`,
          status: 'APPROVED' as const,
          reviewedBy: 'seed',
          reviewedAt: new Date(),
        })),
      });
    }
  }

  // Guyana CountryConfig — the single source for currency, ID-gate, tiers,
  // and document checklists. Adding a country = adding a row, not code.
  const guyanaTiers = { mover: 12000, smallVendor: 20000, largeVendor: 30000 };
  const guyanaChecklists = {
    MOVER: ['national_id', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'],
    // Taxi drivers carry passengers — heaviest checklist: occupational permit,
    // H-plate photo, police clearance, and an annual fitness certificate (§3.4).
    MOVER_TAXI_EXTRA: ['hire_car_permit', 'vehicle_plate_photo', 'police_clearance', 'fitness_cert'],
    RESTAURANT: ['owner_national_id', 'business_registration', 'food_handler_cert'],
    SUPERMARKET: ['owner_national_id', 'business_registration'],
    STORE: ['owner_national_id', 'business_registration'],
    SERVICE: ['owner_national_id'],
    // Hire-a-professional providers (§4.6): ID + police clearance are mandatory.
    SERVICE_PROVIDER: ['national_id', 'police_clearance'],
    CUSTOMER_L2: ['national_id', 'selfie'],
  };
  const guyanaTaxiRates = { base: 1000, perKm: 300, perMin: 25, minimum: 1500 };
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
      subscriptionTiers: guyanaTiers,
      documentChecklists: guyanaChecklists,
      taxiRates: guyanaTaxiRates,
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
      subscriptionTiers: guyanaTiers,
      documentChecklists: guyanaChecklists,
      taxiRates: guyanaTaxiRates,
      cashRules: guyanaCashRules,
      ...guyanaRegion,
      isActive: true,
    },
  });

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
