// The staging drill manifest [STG-DRILLS]. deploy/drill-fixtures.sh builds,
// ON THE SERVER, the fixtures seven journeys need and staging cannot produce
// by itself (apps/api/src/modules/ops/drills/fixtures.ts), and writes their
// ids to a manifest. deploy/journeys-run.sh copies it into the run's results
// and names it in LIVETEST_DRILL_MANIFEST. The runner stays an HTTP client: it
// never builds a fixture and never touches the database; it only reads ids
// and signs the fixture accounts in through the private instance's dev code.
//
// A manifest is refused before the first request unless it is well formed,
// every phone in it is never-a-subscriber (+5920…, gate p), and it was made
// on the very deployment this run targets (gate b) — fixture ids from another
// database would only fail confusingly.

import { readFileSync } from 'node:fs';
import { FICTIONAL_GY, TargetRefused, type TargetIdentity } from './guard.js';

export interface DrillAccount { slot: string; userId: string; phone: string }
export interface DrillBillingStore extends DrillAccount {
  vendorId: string;
  vendorName: string;
  subscriptionId: string;
  san: string | null;
  bornAs: 'TRIAL' | 'BILLED_FROM_DAY_1';
  trialEndedAt: string | null;
}
export interface DrillManifest {
  version: 1;
  runId: string;
  marker: string;
  createdAt: string;
  target: { deploymentId: string; environment: string; database: string };
  billing: { vend04: DrillBillingStore; money03: DrillBillingStore };
  recusal: DrillAccount & { adminPhone: string; linkedBy: 'PHONE' };
  tenant: {
    tenantId: string;
    kind: string;
    customer: DrillAccount;
    storeOwner: DrillAccount;
    partner: DrillAccount & { riderId: string };
    store: { vendorId: string; name: string; itemId: string; itemName: string };
    order: { orderId: string; orderNumber: string };
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, where: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`drill manifest: ${where} is missing`);
  return v;
};
function account(v: unknown, where: string): DrillAccount {
  if (!isObj(v)) throw new Error(`drill manifest: ${where} is missing`);
  return { slot: str(v['slot'], `${where}.slot`), userId: str(v['userId'], `${where}.userId`), phone: str(v['phone'], `${where}.phone`) };
}
function billingStore(v: unknown, where: string): DrillBillingStore {
  if (!isObj(v)) throw new Error(`drill manifest: ${where} is missing`);
  return {
    ...account(v, where),
    vendorId: str(v['vendorId'], `${where}.vendorId`),
    vendorName: str(v['vendorName'], `${where}.vendorName`),
    subscriptionId: str(v['subscriptionId'], `${where}.subscriptionId`),
    san: typeof v['san'] === 'string' ? v['san'] : null,
    bornAs: v['bornAs'] === 'BILLED_FROM_DAY_1' ? 'BILLED_FROM_DAY_1' : 'TRIAL',
    trialEndedAt: typeof v['trialEndedAt'] === 'string' ? v['trialEndedAt'] : null,
  };
}

/** Parse and validate a manifest (throws on any malformed field; refuses a live phone, gate p). */
export function parseDrillManifest(raw: unknown): DrillManifest {
  if (!isObj(raw) || raw['version'] !== 1) throw new Error('drill manifest: not a version-1 manifest');
  const target = isObj(raw['target']) ? raw['target'] : {};
  const billing = isObj(raw['billing']) ? raw['billing'] : {};
  const recusal = isObj(raw['recusal']) ? raw['recusal'] : {};
  const tenant = isObj(raw['tenant']) ? raw['tenant'] : {};
  const store = isObj(tenant['store']) ? tenant['store'] : {};
  const order = isObj(tenant['order']) ? tenant['order'] : {};
  const partner = isObj(tenant['partner']) ? tenant['partner'] : {};
  const m: DrillManifest = {
    version: 1,
    runId: str(raw['runId'], 'runId'),
    marker: str(raw['marker'], 'marker'),
    createdAt: str(raw['createdAt'], 'createdAt'),
    target: { deploymentId: str(target['deploymentId'], 'target.deploymentId'), environment: str(target['environment'], 'target.environment'), database: str(target['database'], 'target.database') },
    billing: { vend04: billingStore(billing['vend04'], 'billing.vend04'), money03: billingStore(billing['money03'], 'billing.money03') },
    recusal: { ...account(recusal, 'recusal'), adminPhone: str(recusal['adminPhone'], 'recusal.adminPhone'), linkedBy: 'PHONE' },
    tenant: {
      tenantId: str(tenant['tenantId'], 'tenant.tenantId'),
      kind: str(tenant['kind'], 'tenant.kind'),
      customer: account(tenant['customer'], 'tenant.customer'),
      storeOwner: account(tenant['storeOwner'], 'tenant.storeOwner'),
      partner: { ...account(partner, 'tenant.partner'), riderId: str(partner['riderId'], 'tenant.partner.riderId') },
      store: { vendorId: str(store['vendorId'], 'tenant.store.vendorId'), name: str(store['name'], 'tenant.store.name'), itemId: str(store['itemId'], 'tenant.store.itemId'), itemName: str(store['itemName'], 'tenant.store.itemName') },
      order: { orderId: str(order['orderId'], 'tenant.order.orderId'), orderNumber: str(order['orderNumber'], 'tenant.order.orderNumber') },
    },
  };
  const live = drillPhones(m).filter((p) => !FICTIONAL_GY.test(p));
  if (live.length > 0) throw new TargetRefused('p', `the drill manifest names phones that could belong to real people (only +5920… may be used): ${live.join(', ')}`);
  return m;
}

/** Every phone the manifest hands the runner (all signed in or filed by the drill journeys). */
export function drillPhones(m: DrillManifest): string[] {
  return [m.billing.vend04.phone, m.billing.money03.phone, m.recusal.phone, m.recusal.adminPhone, m.tenant.customer.phone, m.tenant.storeOwner.phone, m.tenant.partner.phone];
}

/** LIVETEST_DRILL_MANIFEST (a file path), or null when no drill fixtures were made for this run. */
export function loadDrillManifest(env: Record<string, string | undefined> = process.env): DrillManifest | null {
  const path = (env['LIVETEST_DRILL_MANIFEST'] ?? '').trim();
  if (!path) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e: any) {
    throw new Error(`LIVETEST_DRILL_MANIFEST (${path}) is not a readable JSON file: ${e?.message ?? e}`);
  }
  return parseDrillManifest(raw);
}

/** Gate (b) for the manifest: it must describe the deployment this run targets. */
export function refuseForeignManifest(m: DrillManifest, identity: Pick<TargetIdentity, 'deploymentId' | 'environment'>): void {
  if (m.target.deploymentId !== identity.deploymentId || m.target.environment !== identity.environment) {
    throw new TargetRefused('b', `the drill manifest was made on ${m.target.deploymentId}/${m.target.environment}, but this run targets ${identity.deploymentId}/${identity.environment}; make the fixtures on this deployment (deploy/drill-fixtures.sh create)`);
  }
}
