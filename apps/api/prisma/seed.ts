import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.warn('Seeding database...');

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

    // Popular category + items
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

    // Beverages category
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
