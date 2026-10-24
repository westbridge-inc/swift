/**
 * The boot script: build the app (src/app.ts), assert the boot posture, listen.
 * Importing this file starts the server — import ./app to build without booting.
 */
// FIRST: secrets delivered as files (NAME_FILE) become NAME in this process
// before any module below can read process.env. Keep this import on top.
import './boot/secret-files';
import { buildApp } from './app';
import { assertSafeBootConfig, assertProductionData } from './utils/boot-config';
import { attestTenantWallAtBoot } from './boot/tenant-wall';
import { attestSystemLoginAtBoot } from './boot/system-login';
import { runAsSystem } from './plugins/tenant-context';
import { checkDeploymentIdentityAtStart } from './utils/deployment-identity';
import { assertEmergencyPolicySigningConfig } from './modules/country/emergency-policy-signature';

const PORT = parseInt(process.env['PORT'] || '3000', 10);
const HOST = process.env['HOST'] || '0.0.0.0';
async function start() {
  try {
    assertSafeBootConfig();
    // [AUD-G7-023] The emergency-number policy signing key: required in
    // production, refused anywhere when short. HTTP process only (it signs
    // GET /public/emergency-policy); the worker never holds it.
    const emergencyPolicyKey = assertEmergencyPolicySigningConfig();
    // [S3-L1] Only on a database of this process's own kind (its
    // deployment_identity), and BEFORE the app is built: building it starts
    // the in-process job workers.
    await checkDeploymentIdentityAtStart();
    const app = await buildApp();
    // SWIFT-010: refuse to serve a production DB with no active market seeded
    // (empty CountryConfig = every signup rejected). Dev/test/CI skip inside.
    await assertProductionData(app.prisma);

    // [TA-S0-003] Say out loud whether the database tenant wall binds THIS
    // credential, and refuse to serve a second tenant without it. 76 tables
    // carry a tenant policy; under an owner/BYPASSRLS role none of them bind,
    // and until now nothing measured which of those two worlds was running.
    // [MASTER-075] The same attestation the standalone worker runs.
    // [L04 · R1] Under the enforced wall, sign-in reads accounts through the
    // system login, so it must be reachable and a bypass member too. Both,
    // always, in this order (system-login-boot.test.ts gates it).
    await attestTenantWallAtBoot(app.prisma, app.log);
    await attestSystemLoginAtBoot(app.prisma, app.log);

    await app.listen({ port: PORT, host: HOST });
    console.warn(`Swift API running on http://${HOST}:${PORT}`);
    // The PUBLIC half only (never the key): the owner pins it in the app
    // (apps/mobile/src/lib/emergencyPolicyPins.ts) — deploy/PILOT-RUNBOOK.md.
    if (emergencyPolicyKey) app.log.info({ kid: emergencyPolicyKey.kid, ed25519: emergencyPolicyKey.publicKeyHex }, '[AUD-G7-023] emergency policy signing: public key to pin in the app');
    else app.log.warn('[AUD-G7-023] no EMERGENCY_POLICY_SIGNING_KEY (not production): emergency policies are served unsigned and build 12+ phones use their bundled numbers');

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
    // [L01 · tenant wall] Boot seeding writes platform registries and the
    // default tenant's taxonomy (each names its tenant explicitly): named
    // system work, never an unbound composition root.
    void runAsSystem('boot:seed-registries', async () => {
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
        // [VERIFY-DOCS] The hire-car permit split: its switch-over moment is recorded at the first boot
        // that runs it on this environment, and no later boot moves it. [Owner ruling 15 Oct 2026] It
        // grants nothing: there is no grace (verification/hire-permit-grace.ts).
        const { ensureHireSplitStarted } = await import('./modules/verification/hire-permit-grace');
        await ensureHireSplitStarted(app.prisma);
        app.log.info({ docTypes: registry.docTypes, requirementSets: registry.requirementSets, validators: registry.validators }, 'documents: registry seeded');
        // [DOC-INV-2] An ACTIVE document type the registry cannot validate — no
        // profile, no fields, a required field without a validator, a blocking
        // validator with no implementation — is a lie about verification. In
        // production the boot contract stays incomplete (readiness 503); elsewhere
        // the gaps are named so the seed that closes them can be written.
        // The gate throws in production (caught below: readiness stays 503) and warns elsewhere.
        const { enforceRegistryCompletenessAtBoot } = await import('./modules/verification/doc-registry');
        const { resolvesImpl } = await import('./modules/verification/validators');
        await enforceRegistryCompletenessAtBoot(app.prisma, app.log, resolvesImpl);
        // [Row 208 guard · GUARDRAILS §7] The rescue incentive is Swift's own money with no payout
        // path and no deletion block yet: a stored non-zero value keeps production's readiness 503.
        const { enforceRescueIncentiveOffAtBoot } = await import('./modules/dispatch/rescue-incentive-guard');
        await enforceRescueIncentiveOffAtBoot(app.prisma, app.log);
        // [R048-006] The contract is COMPLETE only here. Readiness answers 503
        // until this line runs, so an orchestrator never routes to a process
        // whose category rail would be empty.
        app.markBootContractsComplete();
        // [Owner ruling 15 Oct 2026 · no grace] A taxi driver online on the old hire-car permit alone goes
        // offline the moment this code runs, so no offer reaches them (never fatal; logged on failure).
        const { runHireLicenceSweepAtBoot } = await import('./modules/verification/hire-licence-boot');
        await runHireLicenceSweepAtBoot({ prisma: app.prisma, io: app.io, log: app.log });
      } catch (err) {
        app.log.warn({ err }, 'discovery: taxonomy seed failed — the category rail will be empty (or the document registry seed failed); readiness stays 503');
      }
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
