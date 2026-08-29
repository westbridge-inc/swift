/** @jsxImportSource react */
import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

/**
 * The Swift vertical pictograms (design-100× Part 9.6) — the service verticals
 * drawn by ONE hand on the 24-grid: 1.8 stroke, round caps/joins, single
 * colour, no fills. Grounded in the market-street vernacular (a market basket,
 * an awning storefront, a roof-sign taxi) — never stock glyph-font clipart.
 * Rendered on `brand[50]` tiles in `brand[600]` (the spec's 700-on-100 roles).
 */
export type PictogramName =
  | 'food'
  | 'groceries'
  | 'shops'
  | 'taxi'
  | 'send'
  | 'services'
  | 'orders'
  | 'favourites'
  | 'scan'
  | 'sedan'
  | 'estate'
  | 'van'
  | 'bus'
  | 'wheel'
  | 'plumber'
  | 'electrician'
  | 'carpenter'
  | 'painter'
  | 'ac-fridge'
  | 'mason';

export function Pictogram({
  name,
  size = 28,
  color,
}: {
  name: PictogramName;
  size?: number;
  color: string;
}) {
  // Plumbing keeps the kit's existing wrench rather than tracing a second
  // near-duplicate or mixing an icon-font glyph into the trade family.
  if (name === 'plumber') return <Pictogram name="services" size={size} color={color} />;

  const s = {
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    fill: 'none',
  } as const;

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'food' && (
        <>
          {/* the covered dish — restaurant service, one wisp of heat */}
          <Path {...s} d="M12.6 2.6 C12 3.4 13.1 3.9 12.5 4.8" />
          <Circle {...s} cx={12} cy={7.8} r={1.15} />
          <Path {...s} d="M5.2 15.7 A6.8 6.8 0 0 1 18.8 15.7" />
          <Path {...s} d="M3.6 15.7 H20.4" />
          <Path {...s} d="M6.2 18.9 H17.8" />
        </>
      )}
      {name === 'groceries' && (
        <>
          {/* market basket — wide and shallow, stall vernacular */}
          <Path {...s} d="M9 10 C9 6.2 15 6.2 15 10" />
          <Path {...s} d="M3.6 10 H20.4" />
          <Path {...s} d="M4.8 10 L6.1 17.9 A1.4 1.4 0 0 0 7.5 19 H16.5 A1.4 1.4 0 0 0 17.9 17.9 L19.2 10" />
          <Path {...s} d="M9.4 12.6 L9.9 16.4" />
          <Path {...s} d="M12 12.6 V16.4" />
          <Path {...s} d="M14.6 12.6 L14.1 16.4" />
        </>
      )}
      {name === 'shops' && (
        <>
          {/* awning storefront */}
          <Path {...s} d="M4 8.4 V6.2 H20 V8.4" />
          <Path {...s} d="M4 8.4 A2 2 0 0 0 8 8.4 A2 2 0 0 0 12 8.4 A2 2 0 0 0 16 8.4 A2 2 0 0 0 20 8.4" />
          <Path {...s} d="M5.4 11.4 V19.4 H18.6 V11.4" />
          <Path {...s} d="M13.6 19.4 V14.6 H16.4 V19.4" />
        </>
      )}
      {name === 'taxi' && (
        <>
          {/* roof-sign car, front view — plate-first safety culture rides taxis */}
          <Path {...s} d="M10.2 4.2 H13.8 V6.5 H10.2 Z" />
          <Path {...s} d="M6.4 11 L7.6 7.8 C7.9 7 8.6 6.5 9.4 6.5 H14.6 C15.4 6.5 16.1 7 16.4 7.8 L17.6 11" />
          <Path {...s} d="M4.8 17 V14.2 A3.2 3.2 0 0 1 8 11 H16 A3.2 3.2 0 0 1 19.2 14.2 V17 Z" />
          <Circle {...s} cx={8.2} cy={17.4} r={1.7} />
          <Circle {...s} cx={15.8} cy={17.4} r={1.7} />
        </>
      )}
      {name === 'wheel' && (
        <>
          {/* steering wheel — the earner's mark (first-open trio: Swift Driver) */}
          <Circle {...s} cx={12} cy={12} r={8.4} />
          <Circle {...s} cx={12} cy={12} r={2.4} />
          <Path {...s} d="M3.6 12 H9.6" />
          <Path {...s} d="M14.4 12 H20.4" />
          <Path {...s} d="M12 14.4 V20.4" />
        </>
      )}
      {name === 'send' && (
        <>
          {/* parcel in motion — one box, speed lines */}
          <Path {...s} d="M9.6 7.2 H20.4 V18 H9.6 Z" />
          <Path {...s} d="M15 7.2 V11" />
          <Path {...s} d="M2.6 9.8 H6.6" />
          <Path {...s} d="M4 12.6 H7.4" />
          <Path {...s} d="M2.6 15.4 H6.6" />
        </>
      )}
      {name === 'services' && (
        <>
          {/* wrench */}
          <Path
            {...s}
            d="M14.2 6.9 A4.4 4.4 0 0 0 9 12.1 L4.7 16.4 A2.1 2.1 0 0 0 7.6 19.3 L11.9 15 A4.4 4.4 0 0 0 17.1 9.8 L14.4 12.5 L11.5 9.6 Z"
          />
        </>
      )}
      {name === 'orders' && (
        <>
          {/* receipt with a torn zigzag foot */}
          <Path
            {...s}
            d="M7 4.6 H17 V18.6 L15.33 17.4 L13.67 18.6 L12 17.4 L10.33 18.6 L8.67 17.4 L7 18.6 Z"
          />
          <Path {...s} d="M9.6 8.6 H14.4" />
          <Path {...s} d="M9.6 11.6 H13.2" />
        </>
      )}
      {name === 'favourites' && (
        <Path
          {...s}
          d="M12 19.2 C7.2 15.9 4.6 13.1 4.6 10.1 A3.9 3.9 0 0 1 12 8.4 A3.9 3.9 0 0 1 19.4 10.1 C19.4 13.1 16.8 15.9 12 19.2 Z"
        />
      )}
      {name === 'sedan' && (
        <>
          {/* ride tiers ride a side-view sub-family — same hand */}
          <Path {...s} d="M3.8 15.4 V14.2 C3.8 13.3 4.5 12.6 5.4 12.6 H6.2 L7.6 9.9 C7.9 9.3 8.5 8.9 9.2 8.9 H13.1 C13.6 8.9 14.1 9.1 14.4 9.5 L16.9 12.6 H18.8 C19.7 12.6 20.4 13.3 20.4 14.2 V15.4" />
          <Path {...s} d="M11.6 9 V12.5" />
          <Circle {...s} cx={7.7} cy={15.7} r={1.7} />
          <Circle {...s} cx={16.3} cy={15.7} r={1.7} />
          <Path {...s} d="M9.4 15.6 H14.6" />
        </>
      )}
      {name === 'estate' && (
        <>
          <Path {...s} d="M3.8 15.4 V14.2 C3.8 13.3 4.5 12.6 5.4 12.6 H6 L7.2 9.8 C7.5 9.2 8.1 8.8 8.8 8.8 H15.4 C16 8.8 16.6 9.1 16.9 9.7 L18.4 12.6 H18.8 C19.7 12.6 20.4 13.3 20.4 14.2 V15.4" />
          <Path {...s} d="M11.2 8.9 V12.5" />
          <Path {...s} d="M15.5 8.9 L16.6 12.4" />
          <Circle {...s} cx={7.7} cy={15.7} r={1.7} />
          <Circle {...s} cx={16.3} cy={15.7} r={1.7} />
          <Path {...s} d="M9.4 15.6 H14.6" />
        </>
      )}
      {name === 'van' && (
        <>
          <Path {...s} d="M3.9 15.4 V10.2 C3.9 9.3 4.6 8.6 5.5 8.6 H14.9 C15.6 8.6 16.2 8.9 16.6 9.4 L19.8 13.3 C20.2 13.8 20.4 14.3 20.4 14.9 V15.4" />
          <Path {...s} d="M14.7 8.7 L17.7 12.6 H3.9" />
          <Path {...s} d="M9.8 8.7 V12.5" />
          <Circle {...s} cx={7.5} cy={15.7} r={1.7} />
          <Circle {...s} cx={16.5} cy={15.7} r={1.7} />
          <Path {...s} d="M9.2 15.6 H14.8" />
        </>
      )}
      {name === 'bus' && (
        <>
          <Path {...s} d="M3.8 15.2 V8.3 C3.8 7.4 4.5 6.7 5.4 6.7 H18.6 C19.5 6.7 20.2 7.4 20.2 8.3 V15.2" />
          <Path {...s} d="M3.8 11.4 H20.2" />
          <Path {...s} d="M8.8 6.8 V11.3" />
          <Path {...s} d="M15.2 6.8 V11.3" />
          <Circle {...s} cx={7.3} cy={15.9} r={1.7} />
          <Circle {...s} cx={16.7} cy={15.9} r={1.7} />
          <Path {...s} d="M9 15.4 H15" />
        </>
      )}
      {name === 'electrician' && (
        <>
          {/* breaker board and bolt */}
          <Path {...s} d="M6.2 4.2 H17.8 V19.8 H6.2 Z" />
          <Path {...s} d="M13.3 6.8 L9.3 12 H12.1 L10.7 17.2 L15 11.1 H12.2 Z" />
        </>
      )}
      {name === 'carpenter' && (
        <>
          {/* framing square and rule — straight-edged, never saw-toothed */}
          <Path {...s} d="M5 4.5 H9.2 V14.8 H19 V19 H5 Z" />
          <Path {...s} d="M7.1 7.4 H9.2 M7.1 10.5 H9.2 M7.1 13.6 H9.2 M12.3 14.8 V16.9 M15.4 14.8 V16.9" />
        </>
      )}
      {name === 'painter' && (
        <>
          {/* paint roller */}
          <Path {...s} d="M4.5 5.2 H16.3 A1.7 1.7 0 0 1 18 6.9 V8.3 A1.7 1.7 0 0 1 16.3 10 H4.5 Z" />
          <Path {...s} d="M18 7.6 H20 V12.5 H12 V15" />
          <Path {...s} d="M10.3 15 H13.7 V20 H10.3 Z" />
        </>
      )}
      {name === 'ac-fridge' && (
        <>
          {/* wall unit, snowflake and three cool-air paths */}
          <Path {...s} d="M4 5.2 H20 V14.8 H4 Z" />
          <Path {...s} d="M7 12 H17" />
          <Path {...s} d="M12 7 V10.8 M10.3 8 L13.7 9.9 M13.7 8 L10.3 9.9" />
          <Path {...s} d="M7.5 18.8 C7.5 16.8 8.5 16.5 8.5 14.8 M12 18.8 V14.8 M16.5 18.8 C16.5 16.8 15.5 16.5 15.5 14.8" />
        </>
      )}
      {name === 'scan' && (
        <>
          {/* four viewfinder corners around a code plate — the shape a person
              already reads as "point the camera here" */}
          <Path {...s} d="M4 8.6 V6 A2 2 0 0 1 6 4 H8.6" />
          <Path {...s} d="M15.4 4 H18 A2 2 0 0 1 20 6 V8.6" />
          <Path {...s} d="M20 15.4 V18 A2 2 0 0 1 18 20 H15.4" />
          <Path {...s} d="M8.6 20 H6 A2 2 0 0 1 4 18 V15.4" />
          <Path {...s} d="M9.2 9.2 H11.4 V11.4 H9.2 Z" />
          <Path {...s} d="M14.8 9.2 H12.6 V11.4 H14.8 Z" />
          <Path {...s} d="M9.2 14.8 H11.4 V12.6 H9.2 Z" />
          <Path {...s} d="M12.6 14 H14.8 M13.6 12.6 V14.8" />
        </>
      )}
      {name === 'mason' && (
        <>
          {/* a straight-edged bond wall */}
          <Path {...s} d="M4 5.5 H20 V18.5 H4 Z" />
          <Path {...s} d="M4 9.8 H20 M4 14.2 H20" />
          <Path {...s} d="M9.3 5.5 V9.8 M15 5.5 V9.8 M7 9.8 V14.2 M12.5 9.8 V14.2 M17.5 9.8 V14.2 M9.3 14.2 V18.5 M15 14.2 V18.5" />
        </>
      )}
    </Svg>
  );
}
