/**
 * The boot script: build the app (src/app.ts), assert the boot posture, listen.
 * Importing this file starts the server — import ./app to build without booting.
 */
import { buildApp } from './app';
import { assertSafeBootConfig, assertProductionData } from './utils/boot-config';
import { attestationOf, attestationLine, readRlsFacts, assertTenantWall } from './lib/rls-attestation';
import { rlsAttestationGauge } from './plugins/observability';
import { isProduction } from './utils/runtime-mode';
import { pageOps, resolveOpsPage } from './modules/ops/ops-page';

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

    // [ROUTE-001] ASK THE ROUTING ENGINE WHETHER IT IS ACTUALLY THERE.
    //
    // OsrmMapsProvider degrades to haversine on every failure, which is right
    // at runtime and blinding at deploy time: a permanently unreachable OSRM
    // looks exactly like MAPS_PROVIDER=haversine. That is not hypothetical —
    // .env.deploy.example shipped MAPS_PROVIDER=osrm with an OSRM_URL naming a
    // service in a DIFFERENT compose project, so every fare, ETA and dispatch
    // ranking was a straight line and nothing said so.
    //
    // After listen, never blocking the port, never failing readiness: routing
    // is degradable and taking the instance out of rotation would be the worse
    // outage. It pages ops and records the verdict for /health.
    void (async () => {
      const { getMapsProvider } = await import('./providers/maps/maps-provider');
      const { probeRouting, setLastRoutingProbe } = await import('./providers/maps/routing-probe');
      const verdict = await probeRouting(getMapsProvider());
      setLastRoutingProbe(verdict);
      if (verdict.status === 'ok') {
        app.log.info({ routing: verdict }, `routing: ${verdict.provider} answered (${verdict.km.toFixed(2)} km probe route)`);
        void resolveOpsPage(app.prisma, 'Routing engine unreachable').catch(() => {});
        return;
      }
      if (verdict.status === 'skipped') {
        app.log.info({ routing: verdict }, `routing: not probed — ${verdict.why}`);
        return;
      }
      app.log.error({ routing: verdict }, `ROUTING DEGRADED: ${verdict.why}`);
      const { NotificationService } = await import('./modules/notification/notification.service');
      await pageOps(
        { prisma: app.prisma, redis: app.redis, notifications: new NotificationService(app.prisma, app.io) },
        {
          key: 'ops_page:routing-unreachable',
          title: 'Routing engine unreachable',
          body: `${verdict.why} Fares, ETAs and dispatch ranking are all straight-line until this is fixed.`,
          data: { kind: 'ops_routing_unreachable', provider: verdict.provider },
        },
      );
    })().catch((err) => app.log.error({ err }, 'routing probe failed to run'));

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
        // [DOC-1 §4.2] The document registry mirrors every market's checklist as
        // INACTIVE, provisional rows; the checklist facade keeps answering from
        // the JSON until recorded legal facts activate them. Planted here, at
        // boot after listen, so the rows exist for review and activation and
        // are never minted lazily on a request path.
        const { seedDocRegistry } = await import('./modules/verification/doc-registry');
        const registry = await seedDocRegistry(app.prisma);
        app.log.info({ docTypes: registry.docTypes, requirementSets: registry.requirementSets, validators: registry.validators }, 'documents: registry seeded');
        // [DOC-INV-2] An ACTIVE document type the registry cannot validate — no
        // profile, no fields, a required field without a validator, a blocking
        // validator with no implementation — is a lie about verification. In
        // production the boot contract stays incomplete (readiness 503); elsewhere
        // the gaps are named so the seed that closes them can be written.
        const { registryCompletenessGaps } = await import('./modules/verification/doc-registry');
        const { resolvesImpl } = await import('./modules/verification/validators');
        const gaps = await registryCompletenessGaps(app.prisma, resolvesImpl);
        if (gaps.length > 0) {
          if (isProduction()) {
            throw new Error(`document registry incomplete for active types: ${gaps.slice(0, 8).map((g) => `${g.docTypeCode}:${g.gap}${g.detail ? `(${g.detail})` : ''}`).join(', ')}`);
          }
          app.log.warn({ gaps }, 'documents: registry incomplete for active types — production refuses to boot like this');
        }
        // [R048-006] The contract is COMPLETE only here. Readiness answers 503
        // until this line runs, so an orchestrator never routes to a process
        // whose category rail would be empty.
        app.markBootContractsComplete();
      } catch (err) {
        app.log.warn({ err }, 'discovery: taxonomy seed failed — the category rail will be empty (or the document registry seed failed); readiness stays 503');
      }
    })();
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
