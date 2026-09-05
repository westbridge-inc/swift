/**
 * The boot script: build the app (src/app.ts), assert the boot posture, listen.
 * Importing this file starts the server — import ./app to build without booting.
 */
import { buildApp } from './app';
import { assertSafeBootConfig, assertProductionData } from './utils/boot-config';
import { attestationOf, attestationLine, readRlsFacts, assertTenantWall } from './lib/rls-attestation';
import { rlsAttestationGauge } from './plugins/observability';

const PORT = parseInt(process.env['PORT'] || '3000', 10);
const HOST = process.env['HOST'] || '0.0.0.0';
async function start() {
  try {
    assertSafeBootConfig();
    const app = await buildApp();
    // SWIFT-010: refuse to serve a production DB with no active market seeded
    // (empty CountryConfig = every signup rejected). Dev/test/CI skip inside.
    await assertProductionData(app.prisma);

    // [TA-S0-003] Say out loud whether the database tenant wall binds THIS
    // credential, and refuse to serve a second tenant without it. 76 tables
    // carry a tenant policy; under an owner/BYPASSRLS role none of them bind,
    // and until now nothing measured which of those two worlds was running.
    const rls = attestationOf(await readRlsFacts(app.prisma));
    rlsAttestationGauge.labels(rls.enforced ? 'enforced' : 'bypassed').set(1);
    app.log[rls.enforced ? 'info' : 'warn']({ rls: rls.facts, bypasses: rls.bypasses }, `tenant wall: ${attestationLine(rls)}`);
    assertTenantWall(rls, await app.prisma.tenant.count({ where: { isActive: true } }));

    await app.listen({ port: PORT, host: HOST });
    console.warn(`Swift API running on http://${HOST}:${PORT}`);

    // [MKT G3/G5] PLANT THE DISCOVERY TAXONOMY.
    //
    // `seedDiscoveryTaxonomy` shipped with 14 RETAIL categories, an alias
    // dictionary that is the local moat, and full idempotency — and NOTHING
    // EVER CALLED IT outside tests. So the taxonomy existed in code and in no
    // database: every deployment had zero categories, the rail had nothing to
    // show, and the market feed could only ever return an empty grid however
    // correct its query was. A seeder with no caller is the same defect as an
    // endpoint with no caller, one layer down.
    //
    // Runs AFTER listen, so it can never delay the port opening (the same rule
    // the Meilisearch warm-up follows), and never in tests — they call
    // `buildApp` directly and seed their own tenants explicitly.
    //
    // Idempotent by contract: name/emoji/sortWeight are create-only so a
    // founder's admin edits win forever, and aliases UNION so shipped alias
    // extensions reach existing tenants without trampling admin additions.
    // Failure is logged, never fatal — a missing taxonomy degrades the rail,
    // it must not take the API down.
    void (async () => {
      try {
        const { seedDiscoveryTaxonomy } = await import('./modules/discovery/taxonomy.seed');
        const { created, aliasUpdated } = await seedDiscoveryTaxonomy(app.prisma);
        if (created > 0 || aliasUpdated > 0) {
          app.log.info({ created, aliasUpdated }, 'discovery: taxonomy seeded');
        }
        // [R048-006] The contract is COMPLETE only here. Readiness answers 503
        // until this line runs, so an orchestrator never routes to a process
        // whose category rail would be empty.
        app.markBootContractsComplete();
      } catch (err) {
        app.log.warn({ err }, 'discovery: taxonomy seed failed — the category rail will be empty');
      }
    })();
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
