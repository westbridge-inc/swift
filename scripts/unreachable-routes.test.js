const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const {
  assertNonEmptyRouteCensus,
  isProductionClientFile,
  moduleRoutes,
  registrationPrefixes,
  routePluginName,
  scanRepo,
} = require('./unreachable-routes');

test('reads prefixed and root-mounted plugins from the app composition root', () => {
  const registrations = registrationPrefixes(`
    await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
    await app.register(qrResolverRoutes);
  `);

  assert.equal(registrations.get('ridesRoutes'), '/api/v1/rides');
  assert.equal(registrations.get('qrResolverRoutes'), '');
});

test('recognises named and default async route plugins', () => {
  assert.equal(
    routePluginName('export async function ridesRoutes(app) {}'),
    'ridesRoutes',
  );
  assert.equal(
    routePluginName('export default async function courierRoutes(app) {}'),
    'courierRoutes',
  );
});

test('extracts prefixed and root routes without importing the API', () => {
  const root = '/repo';
  const routes = moduleRoutes(`
    app.get('/active', async () => {});
    app.post<{ Params: { id: string } }>('/:id/cancel', async () => {});
  `, '/api/v1/rides', '/repo/apps/api/src/modules/rides/rides.routes.ts', root);

  assert.deepEqual(routes.map(({ verb, full }) => ({ verb, full })), [
    { verb: 'GET', full: '/api/v1/rides/active' },
    { verb: 'POST', full: '/api/v1/rides/:id/cancel' },
  ]);
});

test('normalises a finite-loop template route and rejects unparsed route calls', () => {
  const dynamic = moduleRoutes(
    'app.put(`/orders/:id/${slug}`, async () => {});',
    '/api/v1/rider',
    '/repo/apps/api/src/modules/rider/rider.routes.ts',
    '/repo',
  );
  assert.equal(dynamic[0].full, '/api/v1/rider/orders/:id/:dynamic');

  assert.throws(
    () => moduleRoutes(
      'app.get(routeFromConfig, async () => {});',
      '/api/v1/example',
      '/repo/apps/api/src/modules/example/example.routes.ts',
      '/repo',
    ),
    /Unsupported route declaration grammar/,
  );
});

test('refuses a vacuous route census', () => {
  assert.throws(
    () => assertNonEmptyRouteCensus([], '/repo/apps/api/src/app.ts'),
    /Route census is empty/,
  );
});

test('test, fixture, and mock text cannot make a client route look reached', () => {
  assert.equal(isProductionClientFile('/repo/apps/mobile/src/api.ts', '/repo'), true);
  assert.equal(isProductionClientFile('/repo/apps/mobile/src/api.test.ts', '/repo'), false);
  assert.equal(isProductionClientFile('/repo/apps/web/src/__tests__/routes.ts', '/repo'), false);
  assert.equal(isProductionClientFile('/repo/apps/admin/src/fixtures/paths.ts', '/repo'), false);
  assert.equal(isProductionClientFile('/repo/apps/desktop/src/mocks/api.ts', '/repo'), false);
});

test('current Swift composition yields a substantial route census', () => {
  const repo = path.resolve(__dirname, '..');
  const { routes, prefixes } = scanRepo(repo);
  const signatures = new Set(routes.map(({ verb, full }) => `${verb} ${full}`));
  const manifestHash = createHash('sha256')
    .update(routes.map(({ verb, full, file }) => `${verb}\t${full}\t${file}`).sort().join('\n'))
    .digest('hex');

  assert.equal(routes.length, 567, 'route-declaration baseline changed; review and update intentionally');
  assert.equal(
    manifestHash,
    'd7e08836f51a842a75f9d48a2aa427ebcb7bcf47068322529814d855402b3f4f',
    'route-declaration manifest changed; inspect the exact added, removed, or moved route before updating',
  );
  assert.equal(prefixes.get('ridesRoutes'), '/api/v1/rides');
  assert.equal(prefixes.get('qrResolverRoutes'), '');
  assert.ok(signatures.has('GET /api/v1/rides/active'));
  assert.ok(signatures.has('GET /health'));
  assert.ok(signatures.has('GET /s/:code'));
  assert.ok(signatures.has('POST /api/v1/courier/order'));
  assert.ok(signatures.has('PUT /api/v1/rider/orders/:id/:dynamic'));
});
