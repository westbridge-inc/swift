'use client';

import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LiveOps } from '@/lib/api';
import { label } from '@/lib/labels';
import { MAP_TILES_NOT_CONFIGURED, opsMapTiles } from '@/lib/map-tiles';

// Georgetown — the launch market's center of gravity.
const CENTER: [number, number] = [6.8013, -58.1551];

/** Colored dot markers via divIcon — no bundled image assets to break. */
function dot(color: string, ring = false) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2.5px solid ${ring ? '#fff' : 'rgba(255,255,255,0.6)'};box-shadow:0 1px 4px rgba(0,0,0,0.5)"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}
const ICONS = {
  riderFree: dot('#34C759'),
  riderBusy: dot('var(--warn)'),
  driverFree: dot('var(--accent)'),
  driverBusy: dot('#BF5AF2'),
  pickup: dot('var(--muted)', true),
};

export function OpsMap({ data }: { data?: LiveOps }) {
  const movers = data?.movers ?? [];
  const orders = (data?.activeOrders ?? []).filter((o) => o.pickupLat != null && o.deliveryLat != null);

  // [ADMIN-TILES] The tiles come from ONE place (lib/map-tiles.ts). None in this build: the
  // pins still draw on a plain ground, and the map says why there is no street map.
  const tiles = opsMapTiles();

  return (
    <MapContainer center={CENTER} zoom={13} style={{ height: '100%', width: '100%', background: '#EFEAE6' }} zoomControl={false}>
      {tiles ? (
        <TileLayer url={tiles.url} attribution={tiles.attribution} />
      ) : (
        <div role="note" className="leaflet-top leaflet-right" style={{ pointerEvents: 'auto', margin: 12, maxWidth: 320, padding: '8px 12px', background: '#fff', border: '1px solid #EAE2E1', borderRadius: 8, color: '#6B5F5F', fontSize: 12, lineHeight: 1.4 }}>
          {MAP_TILES_NOT_CONFIGURED}
        </div>
      )}
      {orders.map((o) => (
        <Polyline
          key={o.id}
          positions={[
            [o.pickupLat as number, o.pickupLng as number],
            [o.deliveryLat as number, o.deliveryLng as number],
          ]}
          pathOptions={{ color: 'var(--accent)', weight: 1.5, opacity: 0.45, dashArray: '4 6' }}
        />
      ))}
      {orders.map((o) =>
        o.pickupLat != null ? (
          <Marker key={`p-${o.id}`} position={[o.pickupLat, o.pickupLng as number]} icon={ICONS.pickup}>
            <Popup>
              <span style={{ fontFamily: 'monospace' }}>#{o.orderNumber}</span> · {label('OrderStatus', o.status)}
              <br />
              {o.vendorName ?? ''}
              <br />
              <a href={`/orders/${o.id}`}>Open order →</a>
            </Popup>
          </Marker>
        ) : null,
      )}
      {movers.map((m) => (
        <Marker
          key={`${m.kind}-${m.id}`}
          position={[m.lat, m.lng]}
          icon={ICONS[`${m.kind}${m.busy ? 'Busy' : 'Free'}` as keyof typeof ICONS]}
        >
          <Popup>
            {m.name ? `${m.name} · ` : ''}{m.kind === 'rider' ? 'Rider' : 'Driver'}
            {m.rideClass ? ` (${label('RideClass', m.rideClass)})` : ''}
            <br />
            {m.busy ? 'on a job' : 'available'}
            <br />
            <a href={`/${m.kind}s/${m.id}`}>Open profile →</a>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}

export default OpsMap;
