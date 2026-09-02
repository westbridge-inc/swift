// Swift load-test ORACLE — pure verdicts, no k6 imports, so vitest can grade it [SCR-003 / SCR-004].
//
// SCR-004: the checkout idempotency oracle compared only status codes — two
// independent orders share a success status, so it could certify the very
// duplicate it claims to prevent. The verdicts below compare the command's
// RESULT: the replay must carry `replayed: true` and the same canonical `data`
// (the same order ids), a changed body under the same key must conflict, and
// the read-only verifier must report exactly the expected order set.
// SCR-003: a mutating run starts only when the target's identity matches the
// signed run manifest field by field.

const canonical = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeys(v[k]); return o; }, {});
  return v;
}
const parse = (res) => { try { return typeof res.body === 'string' ? JSON.parse(res.body) : res.body; } catch { return null; } };

/** The first checkout and its replay: one command, one result. */
export function replayVerdict(first, replay) {
  const a = parse(first); const b = parse(replay);
  if (first.status !== replay.status) return { ok: false, reason: 'status differs' };
  if (!a || !b) return { ok: false, reason: 'unparseable body' };
  if (a.success !== true && b.success !== true) return { ok: true, reason: 'both refused (same honest refusal)' };
  if (b.replayed !== true) return { ok: false, reason: 'replay was not answered from the receipt' };
  if (canonical(a.data) !== canonical(b.data)) return { ok: false, reason: 'replay returned a different result (a second order?)' };
  return { ok: true, reason: 'same command, same result' };
}
/** A changed body under the same key must conflict, never place. */
export function changedBodyVerdict(res) {
  const b = parse(res);
  const ok = res.status === 422 && b && b.error && b.error.code === 'IDEMPOTENCY_KEY_REUSED';
  return { ok, reason: ok ? 'conflict as required' : `expected 422 IDEMPOTENCY_KEY_REUSED, got ${res.status}` };
}
/** The verifier's receipt against the orders the first response named. */
export function cardinalityVerdict(receipt, first) {
  const r = parse(receipt); const a = parse(first);
  if (!r || !r.success) return { ok: false, reason: 'no receipt for the key' };
  const named = orderIdsOf(a && a.data);
  const recorded = [...(r.data.orderIds || [])].sort();
  const ok = named.length > 0 && canonical(named) === canonical(recorded);
  return { ok, reason: ok ? `exactly ${recorded.length} order(s)` : `response named ${named.length}, receipt holds ${recorded.length}` };
}
export function orderIdsOf(data) {
  if (!data) return [];
  if (Array.isArray(data.orders)) return data.orders.map((o) => o.id).filter(Boolean).sort();
  if (Array.isArray(data.orderIds)) return [...data.orderIds].sort();
  if (data.order && data.order.id) return [data.order.id];
  if (data.id) return [data.id];
  return [];
}
/** [SCR-003] Field-by-field: every value the manifest names must be exactly what the target says. */
export function manifestVerdict(identity, manifest) {
  const fields = ['deploymentId', 'environment', 'buildSha', 'testTenant', 'dataClassification'];
  for (const f of fields) {
    if (manifest[f] === undefined) return { ok: false, reason: `manifest lacks ${f}` };
    if (identity[f] !== manifest[f]) return { ok: false, reason: `${f}: target says ${identity[f]}, manifest expects ${manifest[f]}` };
  }
  if (identity.environment === 'production') return { ok: false, reason: 'production is never a load target' };
  if (!identity.lease || !identity.lease.nonce || !(Date.parse(identity.lease.expiresAt) > Date.now())) return { ok: false, reason: 'no live lease' };
  return { ok: true, reason: 'target matches the manifest' };
}
