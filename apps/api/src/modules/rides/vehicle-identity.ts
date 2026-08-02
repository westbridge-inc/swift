import type { PrismaClient, VehicleBodyType } from '@prisma/client';
import { log } from '../../utils/logger';

// Vehicle visual identity [rides spec 6B] — the SERVER half. bodyType and
// colorHex are truth the customer app renders (card = map marker = the car at
// the curb); classification NEVER happens client-side. The mapping below is
// the Georgetown fleet reality (Toyota-dominated); anything unmapped is
// UNKNOWN and surfaces as a one-tap classification in the admin drivers
// review — the reviewer is already looking at the vehicle photos.

const MODEL_BODY: [RegExp, VehicleBodyType][] = [
  // Sedans — the fleet's backbone.
  [/allion|premio|axio|corolla(?!.*(fielder|wagon))|camry|carina|corona|belta|sunny|almera|bluebird|cefiro|lancer|galant|accord|civic(?!.*hatch)|grace|city|integra|impreza(?!.*wagon)|legacy(?!.*wagon)|mark ?(x|ii)|crown|avensis(?!.*wagon)/i, 'SEDAN'],
  // Wagons — Fielder is its own institution here.
  [/fielder|wingroad|ad ?wagon|probox|succeed|caldina|avensis.*wagon|legacy.*wagon|impreza.*wagon|touring/i, 'WAGON'],
  // Minibuses/vans — route taxis and family movers.
  [/noah|voxy|hiace|regius|alphard|vellfire|esquire|serena|caravan|urvan|vanette|stepwgn|step ?wagon|freed(?! ?spike)|mobilio|delica|town ?ace|lite ?ace/i, 'MINIBUS'],
  // SUVs.
  [/rav ?4|cr-?v|hr-?v|x-?trail|harrier|kluger|highlander|land ?cruiser|prado|fortuner|surf|pajero|montero|outlander|vanguard|escudo|vitara|juke|qashqai|dualis|rush|terios|tucson|sportage/i, 'SUV'],
  // Pickups.
  [/hilux|tacoma|navara|frontier|triton|l200|d-?max|dmax|ranger|bt-?50|amarok/i, 'PICKUP'],
  // Hatchbacks.
  [/vitz|yaris|fit(?! ?shuttle)|jazz|swift|march|note(?! ?e-power wagon)|demio|mazda ?2|colt|mirage|starlet|ist|auris|runx|spacio|aqua|prius ?c/i, 'HATCHBACK'],
  // Compacts / kei-adjacent.
  [/passo|boon|alto|wagon ?r|move|mira|picanto|i10|spark|kei/i, 'COMPACT'],
];

/** make+model → bodyType. Model wins; a few make-only defaults; else UNKNOWN. */
export function classifyBodyType(make: string | null | undefined, model: string | null | undefined): VehicleBodyType {
  const haystack = `${make ?? ''} ${model ?? ''}`.trim();
  if (!haystack) return 'UNKNOWN';
  for (const [pattern, body] of MODEL_BODY) {
    if (pattern.test(haystack)) return body;
  }
  return 'UNKNOWN';
}

// Onboarding color words → render tint [6B.4]. White/silver/black get
// dedicated shading variants client-side; the hex here is the tint input.
const COLOR_HEX: Record<string, string> = {
  white: '#F4F4F2',
  silver: '#C6C8CA',
  grey: '#8E9093', gray: '#8E9093',
  black: '#23252A',
  red: '#B03A34',
  maroon: '#6E3B3B',
  blue: '#3B5B8C',
  navy: '#2C3E5D',
  green: '#3F6B4F',
  gold: '#C9A54E',
  beige: '#D8C9A8', cream: '#E8DEC5', champagne: '#D6C6A5',
  brown: '#6B4F3A',
  orange: '#C9722E',
  yellow: '#D9B23A',
  purple: '#5D4470',
  pearl: '#EDEAE4',
  bronze: '#9C7A4F',
  teal: '#3E6E6A',
  wine: '#5E2F3C', burgundy: '#5E2F3C',
};

export function resolveColorHex(colorWord: string | null | undefined): string | null {
  if (!colorWord) return null;
  const w = colorWord.trim().toLowerCase();
  if (COLOR_HEX[w]) return COLOR_HEX[w];
  // "Pearl white", "Dark grey", "Wine red" — last recognizable word wins,
  // then first; unknown stays null (client renders untinted neutral).
  const words = w.split(/[\s/-]+/).filter(Boolean);
  for (const cand of [...words].reverse()) if (COLOR_HEX[cand]) return COLOR_HEX[cand];
  for (const cand of words) if (COLOR_HEX[cand]) return COLOR_HEX[cand];
  return null;
}

/** Backfill [6B.8]: classify every driver missing identity fields. Additive,
 *  idempotent, resumable; UNKNOWNs are counted (the admin classification
 *  queue), never guessed. */
export async function backfillVehicleIdentity(prisma: PrismaClient, batchSize = 500): Promise<{ classified: number; unknown: number; tinted: number }> {
  const out = { classified: 0, unknown: 0, tinted: 0 };
  for (;;) {
    const batch = await prisma.driver.findMany({
      where: { bodyType: null },
      select: { id: true, vehicleMake: true, vehicleModel: true, vehicleColor: true },
      take: batchSize,
    });
    if (batch.length === 0) break;
    for (const d of batch) {
      const bodyType = classifyBodyType(d.vehicleMake, d.vehicleModel);
      const colorHex = resolveColorHex(d.vehicleColor);
      await prisma.driver.update({ where: { id: d.id }, data: { bodyType, colorHex } });
      if (bodyType === 'UNKNOWN') out.unknown += 1;
      else out.classified += 1;
      if (colorHex) out.tinted += 1;
    }
  }
  if (out.unknown > 0) log().info({ unknown: out.unknown }, 'vehicle identity backfill: UNKNOWNs await admin classification');
  return out;
}

/** Read-path resolver: stored value or classify-on-read (heals new drivers
 *  created before their hook ran; never writes from the read path). */
export function vehicleIdentityFor(d: { bodyType: VehicleBodyType | null; colorHex: string | null; vehicleMake: string; vehicleModel: string; vehicleColor: string }): { bodyType: VehicleBodyType; colorHex: string | null } {
  return {
    bodyType: d.bodyType ?? classifyBodyType(d.vehicleMake, d.vehicleModel),
    colorHex: d.colorHex ?? resolveColorHex(d.vehicleColor),
  };
}
