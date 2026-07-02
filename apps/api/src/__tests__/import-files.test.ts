import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import ExcelJS from 'exceljs';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// File imports (master plan §3.1 "CSV/Excel" + "menu PDF parsed into items to
// confirm"). Failure paths first: garbage xlsx is refused, non-PDF menus are
// refused, the AI path fails CLOSED (503, import nothing) when unavailable,
// and a real workbook round-trips through automap → confirm → items.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200368${String(seq).padStart(2, '0')}`,
      firstName: 'File',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'file-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

function multipartBody(filename: string, mime: string, content: Buffer) {
  const boundary = `----swift${nanoid(8)}`;
  const head = Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function postFile(url: string, token: string, filename: string, mime: string, content: Buffer) {
  const { payload, contentType } = multipartBody(filename, mime, content);
  return app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'content-type': contentType, authorization: `Bearer ${token}` },
  });
}

let owner: { userId: string; token: string };
let vendorId: string;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  // Menu parsing must fail CLOSED without the key — force it off for the test.
  delete process.env['ANTHROPIC_API_KEY'];

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id,
      name: `File Foods ${nanoid(4)}`,
      slug: `file-foods-${nanoid(6)}`,
      vendorType: 'SUPERMARKET',
      phone: '+5920036900',
      addressLine1: '4 Sheet Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('Excel import (§3.1)', () => {
  it('a real workbook round-trips: xlsx → automap preview → confirm → items', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Catalogue');
    sheet.addRow(['Product Name', 'Section', 'Unit Cost', 'Qty on hand']);
    sheet.addRow(['Basmati Rice 5kg', 'Groceries', 3500, 40]);
    sheet.addRow(['Cassava Bread', 'Bakery', 800, 12]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const res = await postFile('/api/v1/vendor/items/import/xlsx', owner.token, 'catalogue.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.rowCount).toBe(2);
    expect(data.preview[0].name).toBe('Basmati Rice 5kg');
    expect(data.normalizedCsv).toContain('Cassava Bread');

    // Confirm through the existing CSV import
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/vendor/items/import',
      payload: { csv: data.normalizedCsv },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    });
    expect(confirm.statusCode).toBe(200);

    const items = await app.prisma.item.findMany({ where: { vendorId } });
    expect(items.some((i) => i.name === 'Basmati Rice 5kg' && Number(i.basePrice) === 3500)).toBe(true);
    expect(items.some((i) => i.name === 'Cassava Bread' && i.stockQuantity === 12)).toBe(true);
  });

  it('garbage bytes are refused as BAD_XLSX', async () => {
    const res = await postFile('/api/v1/vendor/items/import/xlsx', owner.token, 'fake.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from('not a zip at all'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_XLSX');
  });
});

describe('Menu PDF parsing (§3.1) — fails closed', () => {
  it('refuses non-PDF uploads', async () => {
    const res = await postFile('/api/v1/vendor/items/import/menu-parse', owner.token, 'menu.jpg',
      'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_MENU_FILE');
  });

  it('with the AI offline, a readable PDF menu gets a clear 503 and imports NOTHING', async () => {
    // Minimal but WELL-FORMED single-page PDF (correct stream length + xref).
    const content = 'BT /F1 12 Tf 72 720 Td (Pepperpot with rice 1500 GYD. Cookup rice 1200 GYD. Mauby 400.) Tj ET';
    const objects = [
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
      `<</Length ${content.length}>>stream\n${content}\nendstream`,
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ];
    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((obj, i) => {
      offsets.push(Buffer.byteLength(body));
      body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xrefStart = Buffer.byteLength(body);
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
    body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
    const pdf = Buffer.from(body);
    const before = await app.prisma.item.count({ where: { vendorId } });
    const res = await postFile('/api/v1/vendor/items/import/menu-parse', owner.token, 'menu.pdf', 'application/pdf', pdf);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('AI_UNAVAILABLE');
    const after = await app.prisma.item.count({ where: { vendorId } });
    expect(after).toBe(before); // nothing imported on the failure path
  });
});
