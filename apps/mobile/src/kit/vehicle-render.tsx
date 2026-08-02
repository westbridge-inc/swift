import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect, Circle, Ellipse } from 'react-native-svg';

// Vehicle visual identity — the render half [rides spec 6B]. Flat-shaded
// pseudo-3D vector art: every body type is generated from ONE parametrized
// construction system (same wheels, same glass treatment, same ground
// shadow), so a sedan, a Noah, and a Hilux are unmistakably siblings —
// mixed styles are the amateur tell the spec bans. Tint comes from the
// server's colorHex; white/silver/black get luminance-aware outlines and
// glass so naive tinting never flattens them [6B.4]. UNKNOWN renders the
// neutral silhouette — never a blank, never an emoji car [6B.7].

export type VehicleBodyType = 'SEDAN' | 'HATCHBACK' | 'WAGON' | 'SUV' | 'PICKUP' | 'MINIBUS' | 'COMPACT' | 'UNKNOWN';
export type VehicleView = 'hero' | 'top';

const NEUTRAL = '#C6C8CA'; // untinted silver — the no-color-word default

// ── Construction parameters (side profile, facing right, 160×64 grid) ──────
interface SideSpec {
  tailX: number; tailTopY: number;      // rear face
  roofRearX: number; roofFrontX: number; roofY: number;
  cowlX: number; cowlY: number;         // windshield base
  noseX: number; noseY: number;         // front tip
  bottomY: number;                      // rocker line
  wheelRearX: number; wheelFrontX: number; wheelR: number;
  bed?: { wallX: number; floorY: number }; // pickup: open bed behind the cab
}

const SIDE: Record<Exclude<VehicleBodyType, 'UNKNOWN'>, SideSpec> = {
  SEDAN:     { tailX: 12, tailTopY: 27, roofRearX: 52, roofFrontX: 94,  roofY: 15, cowlX: 110, cowlY: 27, noseX: 148, noseY: 31, bottomY: 48, wheelRearX: 40, wheelFrontX: 122, wheelR: 9.5 },
  HATCHBACK: { tailX: 22, tailTopY: 19, roofRearX: 36, roofFrontX: 86,  roofY: 15, cowlX: 102, cowlY: 27, noseX: 140, noseY: 32, bottomY: 48, wheelRearX: 46, wheelFrontX: 116, wheelR: 9.5 },
  WAGON:     { tailX: 12, tailTopY: 17, roofRearX: 22, roofFrontX: 92,  roofY: 14, cowlX: 108, cowlY: 27, noseX: 148, noseY: 31, bottomY: 48, wheelRearX: 40, wheelFrontX: 122, wheelR: 9.5 },
  SUV:       { tailX: 14, tailTopY: 13, roofRearX: 26, roofFrontX: 94,  roofY: 10, cowlX: 110, cowlY: 24, noseX: 150, noseY: 27, bottomY: 46, wheelRearX: 42, wheelFrontX: 122, wheelR: 11 },
  PICKUP:    { tailX: 12, tailTopY: 28, roofRearX: 72, roofFrontX: 102, roofY: 13, cowlX: 116, cowlY: 25, noseX: 152, noseY: 29, bottomY: 48, wheelRearX: 38, wheelFrontX: 126, wheelR: 10.5, bed: { wallX: 68, floorY: 28 } },
  MINIBUS:   { tailX: 12, tailTopY: 12, roofRearX: 20, roofFrontX: 110, roofY: 10, cowlX: 128, cowlY: 22, noseX: 150, noseY: 27, bottomY: 48, wheelRearX: 42, wheelFrontX: 120, wheelR: 9.5 },
  COMPACT:   { tailX: 28, tailTopY: 21, roofRearX: 42, roofFrontX: 80,  roofY: 17, cowlX: 94,  cowlY: 29, noseX: 130, noseY: 34, bottomY: 48, wheelRearX: 50, wheelFrontX: 110, wheelR: 9 },
};

function sideBodyPath(s: SideSpec): string {
  if (s.bed) {
    // Pickup: rear face → bed rail → cab rear → roof → windshield → hood → nose.
    return [
      `M ${s.tailX} ${s.bottomY}`,
      `L ${s.tailX} ${s.tailTopY}`,
      `L ${s.bed.wallX} ${s.bed.floorY}`,
      `L ${s.bed.wallX + 2} ${s.roofY + 2}`,
      `Q ${s.bed.wallX + 4} ${s.roofY} ${s.roofRearX} ${s.roofY}`,
      `L ${s.roofFrontX} ${s.roofY}`,
      `Q ${s.roofFrontX + 8} ${s.roofY + 1} ${s.cowlX} ${s.cowlY}`,
      `Q ${(s.cowlX + s.noseX) / 2} ${s.noseY - 2} ${s.noseX} ${s.noseY}`,
      `Q ${s.noseX + 4} ${s.noseY + 2} ${s.noseX + 4} ${s.noseY + 6}`,
      `L ${s.noseX + 4} ${s.bottomY}`,
      'Z',
    ].join(' ');
  }
  return [
    `M ${s.tailX} ${s.bottomY}`,
    `Q ${s.tailX - 2} ${s.tailTopY + 4} ${s.tailX + 2} ${s.tailTopY}`,
    `Q ${(s.tailX + s.roofRearX) / 2} ${s.tailTopY - 4} ${s.roofRearX} ${s.roofY}`,
    `L ${s.roofFrontX} ${s.roofY}`,
    `Q ${s.roofFrontX + 8} ${s.roofY + 1} ${s.cowlX} ${s.cowlY}`,
    `Q ${(s.cowlX + s.noseX) / 2} ${s.noseY - 2} ${s.noseX} ${s.noseY}`,
    `Q ${s.noseX + 4} ${s.noseY + 2} ${s.noseX + 4} ${s.noseY + 6}`,
    `L ${s.noseX + 4} ${s.bottomY}`,
    'Z',
  ].join(' ');
}

function sideGlassPath(s: SideSpec): string {
  const belt = s.cowlY + 1;
  const inset = 3;
  const glassRear = s.bed ? s.bed.wallX + 6 : Math.max(s.tailX + 8, s.roofRearX - 8);
  return [
    `M ${glassRear} ${belt}`,
    `L ${s.roofRearX + 2} ${s.roofY + inset}`,
    `L ${s.roofFrontX - 1} ${s.roofY + inset}`,
    `L ${s.cowlX - 3} ${belt}`,
    'Z',
  ].join(' ');
}

// ── Top view (map marker, nose up, 64×128 grid) ────────────────────────────
interface TopSpec { length: number; width: number; cab?: { from: number; to: number } }
const TOP: Record<Exclude<VehicleBodyType, 'UNKNOWN'>, TopSpec> = {
  SEDAN: { length: 116, width: 46 },
  HATCHBACK: { length: 102, width: 46 },
  WAGON: { length: 120, width: 46 },
  SUV: { length: 116, width: 50 },
  PICKUP: { length: 122, width: 48, cab: { from: 0.42, to: 0.72 } },
  MINIBUS: { length: 124, width: 50 },
  COMPACT: { length: 94, width: 44 },
};

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.6;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Asset resolver [6B.5/6B.7]: ONE decision for every surface. Returns the
 *  spec to draw plus the fallback flag (UNKNOWN → generic sedan silhouette).
 *  Fallbacks are logged so the classification backlog is measurable. */
export function useVehicleAsset(bodyType: VehicleBodyType | null | undefined, colorHex?: string | null) {
  const resolvedType: Exclude<VehicleBodyType, 'UNKNOWN'> =
    bodyType && bodyType !== 'UNKNOWN' && SIDE[bodyType] ? bodyType : 'SEDAN';
  const isFallback = !bodyType || bodyType === 'UNKNOWN' || !SIDE[bodyType as Exclude<VehicleBodyType, 'UNKNOWN'>];
  React.useEffect(() => {
    if (isFallback && bodyType) {
      // eslint-disable-next-line no-console
      console.warn('[vehicle_render_fallback]', { bodyType });
    }
  }, [isFallback, bodyType]);
  const tint = colorHex && /^#[0-9a-fA-F]{6}$/.test(colorHex) ? colorHex : NEUTRAL;
  const lum = luminance(tint);
  return {
    type: resolvedType,
    isFallback,
    tint: isFallback ? NEUTRAL : tint,
    // White/silver need a visible edge on white cards; black needs a lifted
    // edge + lighter glass so the shape never becomes a blob [6B.4].
    outline: lum > 0.72 ? 'rgba(33,26,26,0.22)' : lum < 0.2 ? 'rgba(255,255,255,0.28)' : 'rgba(33,26,26,0.10)',
    glass: lum < 0.2 ? '#46505E' : '#2A313C',
    shade: lum > 0.72 ? 'rgba(33,26,26,0.08)' : 'rgba(0,0,0,0.14)',
  };
}

export interface VehicleRenderProps {
  bodyType: VehicleBodyType | null | undefined;
  view?: VehicleView;
  colorHex?: string | null;
  /** Rendered width in dp; height derives from the view's aspect. */
  size?: number;
  /** Map marker rotation is the Marker's job — the top view draws nose-up. */
}

/** The one vehicle image, everywhere [6B.5]: fare card, driver card, arrival
 *  hero, map marker. Same shape + tint on every surface. */
export function VehicleRender({ bodyType, view = 'hero', colorHex, size = 120 }: VehicleRenderProps) {
  const asset = useVehicleAsset(bodyType, colorHex);

  if (view === 'top') {
    const t = TOP[asset.type];
    const w = size;
    const h = (size * 128) / 64;
    const x = (64 - t.width) / 2;
    const y = (128 - t.length) / 2;
    const glassInset = 6;
    return (
      <View style={{ width: w, height: h }} pointerEvents="none">
        <Svg width={w} height={h} viewBox="0 0 64 128">
          <Rect x={x} y={y} width={t.width} height={t.length} rx={t.width * 0.32} fill={asset.tint} stroke={asset.outline} strokeWidth={1.5} />
          {/* windshield + rear glass bands; pickup gets a bed panel instead of rear glass */}
          <Rect x={x + glassInset} y={y + t.length * 0.16} width={t.width - glassInset * 2} height={t.length * 0.12} rx={4} fill={asset.glass} opacity={0.92} />
          {asset.type === 'PICKUP' && TOP.PICKUP.cab ? (
            <Rect x={x + 3} y={y + t.length * TOP.PICKUP.cab.to} width={t.width - 6} height={t.length * (0.97 - TOP.PICKUP.cab.to)} rx={4} fill={asset.shade} />
          ) : (
            <Rect x={x + glassInset} y={y + t.length * 0.74} width={t.width - glassInset * 2} height={t.length * 0.1} rx={4} fill={asset.glass} opacity={0.8} />
          )}
          {/* roof sheen keeps the body from reading flat */}
          <Rect x={x + glassInset + 2} y={y + t.length * 0.34} width={t.width - glassInset * 2 - 4} height={t.length * 0.34} rx={5} fill="rgba(255,255,255,0.10)" />
          {/* mirrors */}
          <Circle cx={x - 1.5} cy={y + t.length * 0.24} r={2.4} fill={asset.tint} stroke={asset.outline} strokeWidth={0.8} />
          <Circle cx={x + t.width + 1.5} cy={y + t.length * 0.24} r={2.4} fill={asset.tint} stroke={asset.outline} strokeWidth={0.8} />
        </Svg>
      </View>
    );
  }

  const s = SIDE[asset.type];
  const w = size;
  const h = (size * 64) / 160;
  return (
    <View style={{ width: w, height: h }} pointerEvents="none">
      <Svg width={w} height={h} viewBox="0 0 160 64">
        {/* ground shadow — the "sits in the world" cue */}
        <Ellipse cx={82} cy={56} rx={62} ry={4.5} fill="rgba(33,26,26,0.10)" />
        {/* body */}
        <Path d={sideBodyPath(s)} fill={asset.tint} stroke={asset.outline} strokeWidth={1.5} strokeLinejoin="round" />
        {/* rocker shade — flat-shading's one allowed shadow */}
        <Path d={`M ${s.tailX} ${s.bottomY} L ${s.noseX + 4} ${s.bottomY} L ${s.noseX + 4} ${s.bottomY - 5} L ${s.tailX} ${s.bottomY - 5} Z`} fill={asset.shade} />
        {/* pickup bed interior lip */}
        {s.bed ? <Path d={`M ${s.tailX + 3} ${s.tailTopY + 2} L ${s.bed.wallX - 3} ${s.bed.floorY + 1} L ${s.bed.wallX - 3} ${s.bed.floorY + 5} L ${s.tailX + 3} ${s.tailTopY + 6} Z`} fill={asset.shade} /> : null}
        {/* glass band + B-pillar in body color */}
        <Path d={sideGlassPath(s)} fill={asset.glass} opacity={0.94} />
        <Rect x={(s.roofRearX + s.roofFrontX) / 2} y={s.roofY + 2} width={2.5} height={s.cowlY - s.roofY - 1} fill={asset.tint} />
        {/* wheels */}
        {[s.wheelRearX, s.wheelFrontX].map((cx) => (
          <React.Fragment key={cx}>
            <Circle cx={cx} cy={s.bottomY} r={s.wheelR} fill="#26282C" />
            <Circle cx={cx} cy={s.bottomY} r={s.wheelR * 0.45} fill="#8E9093" />
            <Circle cx={cx} cy={s.bottomY} r={s.wheelR * 0.18} fill="#54565A" />
          </React.Fragment>
        ))}
        {/* headlight + taillight ticks */}
        <Rect x={s.noseX - 1} y={s.noseY + 2} width={4.5} height={3} rx={1.2} fill="rgba(255,255,255,0.75)" />
        <Rect x={s.tailX + 1} y={s.tailTopY + 3} width={3.5} height={3} rx={1.2} fill="rgba(176,58,52,0.85)" />
      </Svg>
    </View>
  );
}
