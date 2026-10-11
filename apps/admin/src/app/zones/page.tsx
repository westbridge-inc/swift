'use client';

import { useState, useId, cloneElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchZoneFares, createZoneFare, updateZoneFare, deleteZoneFare,
  type FareZone, type ZoneFare,
} from '@/lib/api';
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
//
// [MISSION CONTROL · PR-3b] The reason is asked in the page, not a browser
// prompt; a refusal stays in the panel with the reason still typed, and
// "sent for a second admin's approval" stays on screen with its link.
// ---------------------------------------------------------------------------

type FareBody = { fromZoneId: string; toZoneId: string; fare: number };

export default function ZonesPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['zone-fares'], queryFn: fetchZoneFares });
  const fares = data?.data?.fares ?? [];
  const zones = data?.data?.zones ?? [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Taxi zones and fares</h1>
      <p className="text-[var(--muted)] text-sm mb-6 max-w-3xl">
        A taxi trip is priced by the market&apos;s formula. A zone can set its own rate per kilometre for trips that
        start or end there (the airports do). A fixed fare for a pair of zones replaces both for a trip from one to
        the other. Changes apply to new quotes only — a ride already requested keeps its fare — and each one needs a
        second admin&apos;s approval.
      </p>

      {error ? (
        <p role="alert" className="text-sm mb-6" style={{ color: 'var(--bad)' }}>
          Couldn&apos;t load the zones and fares: {(error as Error).message}
        </p>
      ) : null}

      <ZoneTable zones={zones} loading={isLoading} />
      <FixedFares fares={fares} zones={zones} loading={isLoading} />
    </div>
  );
}

function ZoneTable({ zones, loading }: { zones: FareZone[]; loading: boolean }) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-3">Zones</h2>
      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-4 text-[var(--muted)] font-medium">Zone</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Market</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Taxi rate per km</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="p-8 text-center text-[var(--muted)]">Loading…</td></tr>
            ) : zones.length === 0 ? (
              <tr><td colSpan={4} className="p-8 text-center text-[var(--muted)]">No zones yet.</td></tr>
            ) : zones.map((z) => (
              <tr key={z.id} className="border-b border-[var(--border)]">
                <td className="p-4 font-medium">{z.name} <span className="text-xs text-[var(--muted)] font-mono ml-1">{z.id}</span></td>
                <td className="p-4">{z.countryCode}</td>
                <td className="p-4 text-right">{z.taxiPerKm == null ? <span className="text-[var(--muted)]">market rate</span> : gyd(z.taxiPerKm)}</td>
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
  // A pricing change answers 202 APPROVAL_REQUIRED: the panel reads it as "sent
  // for a second admin's approval" and the form closes; a refusal keeps it open.
  const actions = useActionRunner(() => {
    setAdding(false);
    setEditing(null);
    void qc.invalidateQueries({ queryKey: ['zone-fares'] });
  });
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? id;
  const pending = <p>A fixed fare is platform pricing: nothing changes until a second admin approves it. It prices new quotes only — a ride already requested keeps its fare.</p>;

  const send = (body: FareBody, row: ZoneFare | null) => void actions.run({
    title: row
      ? `Change the fixed fare ${zoneName(body.fromZoneId)} → ${zoneName(body.toZoneId)} to ${gyd(body.fare)}?`
      : `Add a fixed fare of ${gyd(body.fare)} for ${zoneName(body.fromZoneId)} → ${zoneName(body.toZoneId)}?`,
    body: pending,
    confirmLabel: 'Send for approval',
    submit: ({ reason }) => (row ? updateZoneFare(row.id, body, reason) : createZoneFare(body, reason)),
    success: () => (row ? 'Fixed fare changed. It prices new quotes from now.' : 'Fixed fare added. It prices new quotes from now.'),
  });

  const onDelete = (row: ZoneFare) => void actions.run({
    title: `Remove the fixed fare ${row.fromZoneName} → ${row.toZoneName}?`,
    body: <p>Once a second admin approves, trips between these zones price by the formula and the zones&apos; rates from the next quote.</p>,
    confirmLabel: 'Send for approval',
    submit: ({ reason }) => deleteZoneFare(row.id, { fromZoneId: row.fromZoneId, toZoneId: row.toZoneId }, reason),
    success: () => 'Fixed fare removed. Trips between these zones price by the formula from the next quote.',
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Fixed fares</h2>
        <button
          onClick={() => { actions.clear(); setEditing(null); setAdding(true); }}
          disabled={zones.length === 0}
          className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm hover:bg-[var(--accent)]/80 disabled:opacity-50"
        >
          Add fixed fare
        </button>
      </div>

      {actions.banner}

      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-4 text-[var(--muted)] font-medium">From</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">To</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Fare</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="p-8 text-center text-[var(--muted)]">Loading…</td></tr>
            ) : fares.length === 0 ? (
              <tr><td colSpan={4} className="p-8 text-center text-[var(--muted)]">No fixed fares. Every taxi trip is priced by the formula and the zones&apos; rates.</td></tr>
            ) : fares.map((f) => (
              <tr key={f.id} className="border-b border-[var(--border)]">
                <td className="p-4">{f.fromZoneName}</td>
                <td className="p-4">{f.toZoneName}{f.fromZoneId === f.toZoneId ? <span className="text-xs text-[var(--muted)] ml-1">(within the zone)</span> : null}</td>
                <td className="p-4 text-right font-medium">
                  {gyd(f.fare)}
                  {!f.zonesActive && <span className="block text-xs text-amber-500">a zone is inactive — this prices nothing</span>}
                </td>
                <td className="p-4 text-right whitespace-nowrap">
                  <button onClick={() => { actions.clear(); setAdding(false); setEditing(f); }} aria-label={`Edit ${f.fromZoneName} → ${f.toZoneName}`} className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10 disabled:opacity-50 mr-2">Edit</button>
                  <button onClick={() => onDelete(f)} aria-label={`Delete ${f.fromZoneName} → ${f.toZoneName}…`} className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10 disabled:opacity-50">Delete…</button>
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
          onSubmit={(body) => { actions.clear(); send(body, editing); }}
        />
      )}
    </section>
  );
}

function FareForm({ zones, editing, onCancel, onSubmit }: {
  zones: FareZone[];
  editing: ZoneFare | null;
  onCancel: () => void;
  onSubmit: (_body: FareBody) => void;
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
    onSubmit({ fromZoneId, toZoneId, fare: Number(fare) });
  };

  return (
    <div className="mt-4 bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 max-w-xl">
      <h3 className="font-semibold mb-1">{editing ? 'Change fixed fare' : 'New fixed fare'}</h3>
      <p className="text-xs text-[var(--muted)] mb-4">One direction only: add the return trip as its own fare.</p>
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
      {problem && (fromZoneId || toZoneId || fare) ? <p className="mt-3 text-xs text-amber-500">{problem}</p> : null}
      <div className="flex justify-end gap-3 mt-5">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-white">Cancel</button>
        <button onClick={submit} disabled={!!problem} className="px-5 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent)]/80 disabled:opacity-50">
          Send for approval…
        </button>
      </div>
    </div>
  );
}

const inputCls =
  'mt-1 w-full bg-[var(--panel-2)] text-white px-3 py-2 rounded-lg text-sm border border-[var(--border)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60';

function Field({ label, children }: { label: string; children: React.ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-xs text-[var(--muted)]">{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
