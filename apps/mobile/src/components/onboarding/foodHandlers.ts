// [FOOD-PERMIT · owner ruling 24 Oct 2026] A registered restaurant's owner ticks "Everyone who handles food here holds a
// current food handler's certificate." in Documents, in place of uploading a certificate. Everything here is read from
// the server (GET /verification/status → foodHandlerAttestation): the words, their version and each store's state. The
// app never supplies the words itself, so an older server — or a malformed answer — shows no tick at all.
// No React Native imports: the screens and their tests share it.

/** The step's code in the server's `checklist` (the registry's FOOD_HANDLER_ATTESTATION_TYPE): drawn as the tick, never an upload. */
export const FOOD_HANDLERS_DOC = 'food_handler_attestation';

export interface FoodHandlerStore { vendorId: string; name: string; attested: boolean }

function view(status: unknown): Record<string, unknown> | null {
  const v = (status as { foodHandlerAttestation?: unknown } | null | undefined)?.foodHandlerAttestation;
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** The server's words and version, or null when it sent none. */
export function foodHandlerTickFrom(status: unknown): { version: string; tick: string } | null {
  const v = view(status);
  if (!v || typeof v['version'] !== 'string' || typeof v['tick'] !== 'string' || !v['tick']) return null;
  return { version: v['version'], tick: v['tick'] };
}

/** The stores whose owner has not ticked yet (none when the server sent no words). */
export function foodHandlerStoresToTick(status: unknown): FoodHandlerStore[] {
  const v = view(status);
  if (!v || !foodHandlerTickFrom(status) || !Array.isArray(v['stores'])) return [];
  return (v['stores'] as unknown[]).filter((s): s is FoodHandlerStore => {
    const r = s as Partial<FoodHandlerStore> | null;
    return !!r && typeof r.vendorId === 'string' && typeof r.name === 'string' && r.attested === false;
  });
}
