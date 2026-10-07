import { grantStepUp } from '../helpers/step-up';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { createGolden, DAY } from './gold-7-helpers';
import { documentHarness } from './gold-7-documents';

// ---------------------------------------------------------------------------
// GOLD-7 · AUTH-04 — block → finish purchase → retry deletion → erase real
// encrypted documents → revoke ALL sessions, in one mounted HTTP journey.
// The initial customer identity document is a historical verification fixture;
// its bytes are uploaded through the real encrypted upload route. KYC review
// itself belongs to AUTH-03. The completed order remains with redacted contact.
// Phone +5920972nnn: range-audited. Live provider deletion is staging-only;
// this suite proves the local storage adapter's actual ciphertext deletion.
// Append-only deletion receipts remain as the erasure evidence by design.
// ---------------------------------------------------------------------------
const h = createGolden('+5920972', 'gold7-auth04');
const docs = documentHarness(h, 'auth04');
beforeAll(() => docs.start());
afterAll(() => docs.close());

describe('GOLD-7 · AUTH-04 — completed-order erasure retry', () => {
  it('blocks an active purchase, completes it, then erases its customer documents and revokes every old session', async () => {
    const owner = await h.actor(['VENDOR_OWNER']);
    const store = await h.vendor(owner);
    const customer = await h.actor();
    const secondToken = h.app.jwt.sign({ userId: customer.userId, role: 'CUSTOMER', jti: nanoid(8) });
    const secondRefresh = nanoid(48);
    await h.sys(() => h.app.prisma.session.create({ data: {
      userId: customer.userId, token: secondToken, refreshToken: secondRefresh,
      deviceId: 'gold7-second-device', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    } }));
    const uploaded = await docs.upload(customer, docs.bytes());
    expect(uploaded.statusCode).toBe(200);
    const fileUrl = uploaded.json().data.url as string;
    const document = await h.sys(() => h.app.prisma.verificationDocument.create({ data: {
      userId: customer.userId, role: 'CUSTOMER', docType: 'identity_l2', fileUrl,
      consentAt: new Date(), privacyNoticeVersion: 'v1',
    } }));
    const cipher = await docs.storage().getObject(fileUrl);
    expect(cipher.length).toBeGreaterThan(0);
    const envelope = await h.sys(() => h.app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: fileUrl } }));
    expect(envelope.wrappedDek !== null).toBe(true);
    await h.fillCart(customer, { vendorId: store.vendorId, itemId: store.itemId });
    const placed = await h.call('POST', '/api/v1/customer/checkout', customer.token,
      { paymentMethod: 'CASH', fulfillmentSelections: { [store.vendorId]: 'PICKUP' } },
      { 'idempotency-key': `g7-delete-${nanoid(8)}` });
    expect(placed.statusCode).toBe(200);
    const id = placed.json().data.order.id as string;
    await h.sys(() => grantStepUp(h.app, customer.token));
    const blocked = await h.call('DELETE', '/api/v1/customer/account', customer.token);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('ACTIVE_ORDERS');
    expect(await h.sys(() => h.app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: document.id } }))).toEqual(document);
    const stillSealed = await h.sys(() => h.app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: fileUrl } }));
    expect(Buffer.from(stillSealed.wrappedDek!).equals(Buffer.from(envelope.wrappedDek!))).toBe(true);
    expect((await docs.storage().getObject(fileUrl)).equals(cipher)).toBe(true);
    expect(await h.sys(() => h.app.prisma.session.count({ where: { userId: customer.userId } }))).toBe(2);

    // LIFECYCLE_V2 hold timing is separately covered by the existing suites.
    await h.sys(() => h.app.prisma.order.update({ where: { id }, data: { holdExpiresAt: null } }));
    for (const [step, status] of [['accept', 'ACCEPTED'], ['preparing', 'PREPARING'], ['ready', 'READY_FOR_PICKUP']]) {
      const next = await h.call('PUT', `/api/v1/vendor/orders/${id}/${step}`, owner.token, undefined, { 'x-vendor-id': store.vendorId });
      expect(next.statusCode, next.json().error?.code).toBe(200);
      expect(next.json().data.status).toBe(status);
    }
    const detail = await h.call('GET', `/api/v1/customer/orders/${id}`, customer.token);
    expect(detail.statusCode).toBe(200);
    expect((await h.call('PUT', `/api/v1/vendor/orders/${id}/complete-pickup`, owner.token,
      { code: detail.json().data.pickupCode }, { 'x-vendor-id': store.vendorId })).statusCode).toBe(200);
    const completed = await h.sys(() => h.app.prisma.order.findUniqueOrThrow({ where: { id } }));
    expect(completed.status).toBe('COMPLETED');
    await h.rememberClusters(customer.userId); // deletion removes the membership
    const deleted = await h.call('DELETE', '/api/v1/customer/account', customer.token);
    expect(deleted.statusCode, deleted.json().error?.code).toBe(200);
    expect(deleted.json()).toMatchObject({ success: true, data: { deleted: true } });
    const tombstone = await h.sys(() => h.app.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } }));
    expect(tombstone).toMatchObject({ status: 'DEACTIVATED', phone: `deleted:${customer.userId}`,
      firstName: 'Deleted', lastName: 'User', email: null, isPhoneVerified: false, selfieCapturedAt: null });
    const erased = await h.sys(() => h.app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: document.id } }));
    expect(erased.fileUrl).toBe('');
    expect(erased.purgedAt).toBeInstanceOf(Date);
    const shredded = await h.sys(() => h.app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: fileUrl } }));
    expect(shredded.wrappedDek === null).toBe(true);
    expect(shredded.shreddedAt).toBeInstanceOf(Date);
    await expect(docs.storage().getObject(fileUrl)).rejects.toMatchObject({ code: 'ENOENT' });
    const receipts = await h.sys(() => h.app.prisma.deletionReceipt.findMany({ where: { submissionId: document.id } }));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ subjectId: customer.userId, deletedBy: customer.userId,
      verificationProbeResult: 'CONFIRMED_ABSENT', bytesDeleted: BigInt(cipher.length) });
    expect(await h.sys(() => h.app.prisma.session.count({ where: { userId: customer.userId } }))).toBe(0);
    expect(await h.sys(() => h.app.prisma.address.count({ where: { userId: customer.userId } }))).toBe(0);
    for (const [token, refreshToken] of [[customer.token, customer.refreshToken], [secondToken, secondRefresh]]) {
      expect((await h.call('GET', '/api/v1/auth/me', token!)).statusCode).toBe(401);
      expect((await h.call('POST', '/api/v1/auth/refresh', token!, { refreshToken })).statusCode).toBe(401);
    }
    const retained = await h.call('GET', `/api/v1/vendor/orders/${id}`, owner.token, undefined, { 'x-vendor-id': store.vendorId });
    expect(retained.statusCode).toBe(200);
    expect(retained.json().data).toMatchObject({ id, status: 'COMPLETED',
      customer: { firstName: 'Deleted', lastName: 'User', phone: null }, deliveryAddress: null, deliveryLat: null, deliveryLng: null });
    expect(Number((await h.sys(() => h.app.prisma.order.findUniqueOrThrow({ where: { id } }))).totalAmount)).toBe(Number(completed.totalAmount));
  });
});
