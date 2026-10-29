'use client';

import { useState, useId, cloneElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchZoneFares, createZoneFare, updateZoneFare, deleteZoneFare,
  type FareZone, type ZoneFare,
} from '@/lib/api';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { fareProblem, gyd, ZONE_FARE_MAX, ZONE_FARE_MIN } from '@/lib/zoneFares';

// ---------------------------------------------------------------------------
// [ZONE-FARES] Taxi zones and their prices.
//
// A zone may carry its own taxi per-km rate (airports do: the owner's ruling,
// 1 Oct 2026). A FIXED fare for a pair of zones overrides both the formula and
// those rates for a trip that starts in one and ends in the other. Every
// change is platform pricing: the operator says why, a second admin approves
// it in the approvals queue, and only then does it happen — so this screen
// never shows a change as made until the server says it was. A change prices
// NEW quotes only; a ride already requested keeps the fare it was booked at.
// ---------------------------------------------------------------------------

export default function ZonesPage() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['zone-fares'], queryFn: fetchZoneFares });
  const fares = data?.data?.fares ?? [];
  const zones = data?.data?.zones ?? [];

  return (
    <div className="mc-page">
      <p className="mc-muted text-sm mb-6 max-w-3xl">
        A taxi trip is priced by the market&apos;s formula. A zone can set its own rate per kilometre for trips that
        start or end there (the airports do). A fixed fare for a pair of zones replaces both for a trip from one to
        the other. Changes apply to new quotes only — a ride already requested keeps its fare — and each one needs a
        second admin&apos;s approval.
      </p>

      {/* [BUG-GUARDS C3] A failed read is never "No zones yet" / "No fixed fares": the tables
          only render once the read answered (failed-read-never-empty.census.test.ts). */}
      {error ? (
        <QueryFailed error={error} what="the zones and fares" onRetry={() => void refetch()} retrying={isFetching} className="mb-6" />
      ) : (
        <>
          <ZoneTable zones={zones} loading={isLoading} />
          <FixedFares fares={fares} zones={zones} loading={isLoading} />
        </>
      )}
    </div>
  );
}

function ZoneTable({ zones, loading }: { zones: FareZone[]; loading: boolean }) {
  return (
    <section className="mb-8">
      <h2 className="mc-section-title">Zones</h2>
      <div className="mc-table-wrap overflow-x-auto">
        <table className="mc-table mc-table-auto">
          <thead>
            <tr >
              <th className="mc-label text-left">Zone</th>
              <th className="mc-label text-left">Market</th>
              <th className="mc-label text-right">Taxi rate per km</th>
              <th className="mc-label text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="mc-table-empty">Loading…</td></tr>
            ) : zones.length === 0 ? (
              <tr><td colSpan={4} className="mc-table-empty">No zones yet.</td></tr>
            ) : zones.map((z) => (
              <tr key={z.id} >
                <td className="p-4 font-medium">{z.name} <span className="text-xs mc-muted font-mono ml-1">{z.id}</span></td>
                <td className="p-4">{z.countryCode}</td>
                <td className="p-4 text-right">{z.taxiPerKm == null ? <span className="mc-muted">market rate</span> : gyd(z.taxiPerKm)}</td>
                <td className="p-4">{z.isActive ? 'Active' : 'Inactive'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FixedFares({ fares, zones, loading }: { fares: ZoneFare[]; zones: FareZone[]; loading: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ZoneFare | null>(null);

  // [U28] A pricing change is C5: its first answer is a second admin's
  // approval. The form used to stay open and filled after that answer, so a
  // second "Send for approval" filed a duplicate. The panel asks why, sends,
  // and shows every answer; once it went through OR is queued the form closes,
  // so nothing is left to press twice. A refusal keeps the form for a fix.
  const actions = useActionRunner(() => {
    setAdding(false);
    setEditing(null);
    void qc.invalidateQueries({ queryKey: ['zone-fares'] });
  });

  const onDelete = (row: ZoneFare) => void actions.run({
    title: `Remove the fixed fare ${row.fromZoneName} → ${row.toZoneName}?`,
    body: <p>Trips between these zones are then priced by the formula and the zones&apos; rates. A second admin approves it first.</p>,
    confirmLabel: 'Remove fixed fare',
    submit: ({ reason }) => deleteZoneFare(row.id, { fromZoneId: row.fromZoneId, toZoneId: row.toZoneId }, reason),
    success: () => 'Fixed fare removed. Trips between these zones price by the formula from the next quote.',
  });

  const onSubmit = (body: { fromZoneId: string; toZoneId: string; fare: number }, route: string) => void actions.run({
    title: editing ? `Change the fixed fare ${route} to ${gyd(body.fare)}?` : `Add a fixed fare ${route} of ${gyd(body.fare)}?`,
    body: <p>It prices new quotes once it is in place. A second admin approves it first.</p>,
    confirmLabel: editing ? 'Change fixed fare' : 'Add fixed fare',
    submit: ({ reason }) => (editing ? updateZoneFare(editing.id, body, reason) : createZoneFare(body, reason)),
    success: () => (editing ? 'Fixed fare changed. It prices new quotes from now.' : 'Fixed fare added. It prices new quotes from now.'),
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="mc-section-title mb-0">Fixed fares</h2>
        <button
          type="button"
          onClick={() => { actions.clear(); setEditing(null); setAdding(true); }}
          disabled={zones.length === 0}
          className="mc-btn mc-btn-primary"
        >
          Add fixed fare
        </button>
      </div>

      {actions.banner}

      <div className="mc-table-wrap overflow-x-auto">
        <table className="mc-table mc-table-auto">
          <thead>
            <tr >
              <th className="mc-label text-left">From</th>
              <th className="mc-label text-left">To</th>
              <th className="mc-label text-right">Fare</th>
              <th className="mc-label text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="mc-table-empty">Loading…</td></tr>
            ) : fares.length === 0 ? (
              <tr><td colSpan={4} className="mc-table-empty">No fixed fares. Every taxi trip is priced by the formula and the zones&apos; rates.</td></tr>
            ) : fares.map((f) => (
              <tr key={f.id} >
                <td className="p-4">{f.fromZoneName}</td>
                <td className="p-4">{f.toZoneName}{f.fromZoneId === f.toZoneId ? <span className="text-xs mc-muted ml-1">(within the zone)</span> : null}</td>
                <td className="p-4 text-right font-medium">
                  {gyd(f.fare)}
                  {!f.zonesActive && <span className="block text-xs mc-text-warn">a zone is inactive — this prices nothing</span>}
                </td>
                <td className="p-4 text-right whitespace-nowrap">
                  <button type="button" onClick={() => { actions.clear(); setAdding(false); setEditing(f); }} aria-label={`Edit the fixed fare ${f.fromZoneName} to ${f.toZoneName}`} className="mc-btn mr-2">Edit</button>
                  <button type="button" onClick={() => onDelete(f)} aria-label={`Delete the fixed fare ${f.fromZoneName} to ${f.toZoneName}`} className="mc-btn">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(adding || editing) && (
        <FareForm
          // [Sol F2] One form per row (or one for "add"): switching rows mounts a
          // fresh form from that row, never the previous row's pair and amount.
          key={editing ? `edit-${editing.id}` : 'add'}
          zones={zones}
          editing={editing}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSubmit={onSubmit}
        />
      )}
    </section>
  );
}

function FareForm({ zones, editing, onCancel, onSubmit }: {
  zones: FareZone[];
  editing: ZoneFare | null;
  onCancel: () => void;
  onSubmit: (_body: { fromZoneId: string; toZoneId: string; fare: number }, _route: string) => void;
}) {
  const [fromZoneId, setFrom] = useState(editing?.fromZoneId ?? '');
  const [toZoneId, setTo] = useState(editing?.toZoneId ?? '');
  const [fare, setFare] = useState(editing?.fare != null ? String(editing.fare) : '');
  // [Sol F3] A fixed fare joins two zones of ONE market (the server refuses
  // anything else): the To list offers the From zone's market only, and a pair
  // that still ends up across two markets is never sent.
  const market = (id: string) => zones.find((z) => z.id === id)?.countryCode ?? null;
  const toChoices = fromZoneId ? zones.filter((z) => z.countryCode === market(fromZoneId)) : zones;
  const problem = !fromZoneId || !toZoneId ? 'Choose both zones.'
    : market(fromZoneId) !== market(toZoneId) ? 'Both zones must be in the same market.'
      : fareProblem(fare);
  const name = (id: string) => zones.find((z) => z.id === id)?.name ?? id;

  const submit = () => {
    if (problem) return;
    onSubmit({ fromZoneId, toZoneId, fare: Number(fare) }, `${name(fromZoneId)} → ${name(toZoneId)}`);
  };

  return (
    <div className="mt-4 bg-[var(--mc-card)] rounded-[var(--mc-radius)] border border-[var(--mc-line)] p-6 max-w-xl">
      <h3 className="font-semibold mb-1">{editing ? 'Change fixed fare' : 'New fixed fare'}</h3>
      <p className="text-xs mc-muted mb-4">One direction only: add the return trip as its own fare.</p>
      <div className="space-y-3">
        <Field label="From zone">
          <select value={fromZoneId} onChange={(e) => setFrom(e.target.value)} disabled={!!editing} className={inputCls}>
            <option value="">Choose a zone</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name} ({z.countryCode})</option>)}
          </select>
        </Field>
        <Field label="To zone">
          <select value={toZoneId} onChange={(e) => setTo(e.target.value)} disabled={!!editing} className={inputCls}>
            <option value="">Choose a zone</option>
            {toChoices.map((z) => <option key={z.id} value={z.id}>{z.name} ({z.countryCode})</option>)}
            {toZoneId && !toChoices.some((z) => z.id === toZoneId)
              ? <option value={toZoneId}>{name(toZoneId)} ({market(toZoneId)}) — another market</option>
              : null}
          </select>
        </Field>
        <Field label="Fare (whole amount)">
          <input type="number" inputMode="numeric" step={1} min={ZONE_FARE_MIN} max={ZONE_FARE_MAX} value={fare} onChange={(e) => setFare(e.target.value)} className={inputCls} />
        </Field>
      </div>
      {problem && (fromZoneId || toZoneId || fare) ? <p className="mt-3 text-xs mc-text-warn">{problem}</p> : null}
      <div className="flex justify-end gap-3 mt-5">
        <button type="button" onClick={onCancel} className="mc-btn mc-btn-quiet">Cancel</button>
        <button type="button" onClick={submit} disabled={!!problem} className="mc-btn mc-btn-primary">
          Send for approval
        </button>
      </div>
    </div>
  );
}

const inputCls =
  'mc-input mt-1';

function Field({ label, children }: { label: string; children: React.ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mc-muted text-xs">{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
