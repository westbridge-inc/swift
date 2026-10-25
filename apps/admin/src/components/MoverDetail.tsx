'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchRiderDetail,
  fetchDriverDetail,
  fetchMoverActivationChecklist,
  verifyRiderDocuments,
  verifyDriverDocuments,
  setDriverRideClass,
  type MoverActivationChecklist,
} from '@/lib/api';
import { label, ratingText, type Tone } from '@/lib/labels';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { Truncate } from '@/components/mc/Truncate';
import { ActivationChecklist } from '@/components/mc/ActivationChecklist';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-2] Rider (delivery/courier) and driver (taxi) pages.
//
// The page reads the mover's activation checklist: every required document for
// their vehicle, and the live-operation gate the Verify button obeys. "Verify…"
// appears only when that gate allows it; until then the page says what is
// missing and links the mover in the Review Center. Every answer — the verify,
// a ride-class change, a refusal — is shown in words (the old page dropped
// them), and a failed load says so instead of "Not found".
// Group (minibus) rides stay off at launch (owner ruling, 6 Oct).
// ---------------------------------------------------------------------------

const RIDE_CLASSES = ['ECONOMY', 'COMFORT', 'XL'] as const;

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const gyd = (n: unknown) => `G$${Number(n || 0).toLocaleString('en-GY', { maximumFractionDigits: 2 })}`;

function Row({ label: name, children }: { label: string; children: React.ReactNode }) {
  if (children == null || children === '') return null;
  return (
    <div className="mc-row">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Where this mover stands, in one sentence, from the server's verdict. */
function moverVerdict(c: MoverActivationChecklist, name: string): { tone: Tone; text: string } {
  switch (c.next) {
    case 'VERIFIED':
      return c.live.allowed
        ? { tone: 'good', text: `Verified. ${name} can go online.` }
        : { tone: 'bad', text: `Verified earlier, but a required document is no longer current, so ${name} cannot go online until it is renewed.` };
    case 'CAN_VERIFY':
      return { tone: 'info', text: 'Every required document is approved and current. You can verify them now.' };
    case 'NEEDS_INSURANCE':
      return { tone: 'warn', text: 'Waiting for current HIRE-class insurance. Passenger work needs it approved before they can be verified.' };
    case 'NEEDS_DOCUMENTS':
      return c.checklist.complete
        ? { tone: 'warn', text: 'Every document is approved, but a vehicle document belongs to a different vehicle than the one on their profile. Review it in the Review Center.' }
        : { tone: 'warn', text: 'Waiting for documents. Decide each one in the Review Center; you can verify once all are approved.' };
  }
}

export function MoverDetail({ id, kind }: { id: string; kind: 'rider' | 'driver' }) {
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const [result, setResult] = useState<Outcome | null>(null);
  const isDriver = kind === 'driver';
  const profile = useQuery({
    queryKey: [kind, id],
    queryFn: () => (isDriver ? fetchDriverDetail(id) : fetchRiderDetail(id)),
  });
  const checklist = useQuery({ queryKey: [`${kind}-checklist`, id], queryFn: () => fetchMoverActivationChecklist(kind, id) });

  const show = (outcome: Outcome | null) => {
    if (!outcome) return;
    setResult(outcome);
    void qc.invalidateQueries({ queryKey: [kind, id] });
    void qc.invalidateQueries({ queryKey: [`${kind}-checklist`, id] });
    void qc.invalidateQueries({ queryKey: [`${kind}s`] });
  };

  const listHref = isDriver ? '/drivers' : '/riders';
  const listLabel = isDriver ? 'Drivers' : 'Riders';
  const back = (
    <Link href={listHref} className="mc-back">
      <ArrowLeft size={16} aria-hidden="true" /> {listLabel}
    </Link>
  );

  const m: any = profile.data?.data;
  if (profile.isLoading) {
    return <div className="mc-page">{back}<div className="mc-card" aria-busy="true">Loading…</div></div>;
  }
  if (profile.isError || !m) {
    return (
      <div className="mc-page">
        {back}
        <QueryFailed
          error={profile.error ?? new Error('The server sent no record.')}
          what={isDriver ? 'this driver' : 'this rider'}
          onRetry={() => void profile.refetch()}
          retrying={profile.isFetching}
        />
      </div>
    );
  }

  const name = [m.user?.firstName, m.user?.lastName].filter(Boolean).join(' ') || 'Unnamed';
  const vehicle = [m.vehicleColor, m.vehicleMake, m.vehicleModel].filter(Boolean).join(' ');
  const sub = m.subscription;
  const earnings: any[] = m.earnings ?? [];
  const earned = earnings.reduce((a, e) => a + Number(e.amount ?? 0), 0);
  const c: MoverActivationChecklist | undefined = checklist.data?.data;
  const context = { applicantId: m.user?.id ?? c?.applicantId };

  const verify = async () => show(await dialog.run({
    title: `Verify ${name}'s documents?`,
    body: <p>Their required documents are approved and current. Verifying lets them go online, and their 14-day free trial starts.</p>,
    confirmLabel: 'Verify documents',
    reason: { hint: 'Kept on the permanent record.' },
    context,
    submit: ({ reason }) => (isDriver ? verifyDriverDocuments(id, reason) : verifyRiderDocuments(id, reason)),
    success: () => `${name} is verified and can go online.`,
  }));

  const setRideClass = async (cls: string) => show(await dialog.run({
    title: `Set ${name}'s ride class to ${label('RideClass', cls)}?`,
    body: <p>Riders asking for a {label('RideClass', cls)} can be matched to them. Confirm the vehicle fits before you change it.</p>,
    confirmLabel: 'Change ride class',
    reason: { hint: 'Kept on the permanent record.' },
    context,
    submit: ({ reason }) => setDriverRideClass(id, cls, reason),
    success: () => `${name} now drives ${label('RideClass', cls)} rides.`,
  }));

  return (
    <div className="mc-page">
      {back}

      <header className="flex flex-wrap items-start gap-4 mb-5">
        <div
          aria-hidden="true"
          className="mc-numbers grid place-items-center shrink-0 w-12 h-12 rounded-full text-white text-lg font-bold"
          style={{ background: 'var(--mc-accent)' }}
        >
          {name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="mc-numbers text-2xl font-semibold leading-tight" style={{ letterSpacing: '-0.02em' }}>
            <Truncate text={name} lines={2} focusable />
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className={`mc-badge ${m.documentsVerified ? 'mc-tone-good' : 'mc-tone-warn'}`}>
              {m.documentsVerified ? 'Documents verified' : 'Documents not verified'}
            </span>
            <span className={`mc-badge${m.isOnline ? ' mc-tone-good' : ''}`}>{m.isOnline ? 'Online' : 'Offline'}</span>
            {isDriver && m.rideClass ? <span className="mc-badge mc-tone-info">{label('RideClass', m.rideClass)}</span> : null}
          </div>
          <p className="mc-muted mt-1.5">
            {[isDriver ? 'Taxi driver' : label('RiderType', m.riderType), m.user?.phone, `Joined ${when(m.user?.createdAt)}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto sm:ml-auto">
          {c?.next === 'CAN_VERIFY' ? (
            <button type="button" className="mc-btn mc-btn-primary" onClick={verify}>Verify…</button>
          ) : null}
        </div>
      </header>

      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-5" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4 min-w-0">
          {c ? (
            <ActivationChecklist
              title={`Required documents · ${label('VehicleType', c.vehicleType)}`}
              items={c.checklist.items}
              applicantId={c.applicantId}
              verdict={moverVerdict(c, name)}
            />
          ) : checklist.isLoading ? (
            <div className="mc-card" aria-busy="true">Loading the document checklist…</div>
          ) : (
            <QueryFailed error={checklist.error} what="the document checklist" onRetry={() => void checklist.refetch()} retrying={checklist.isFetching} />
          )}

          {isDriver ? (
            <section aria-labelledby="ride-class" className="mc-card">
              <h2 id="ride-class" className="mc-label">Ride class</h2>
              <div className="flex flex-wrap gap-2">
                {RIDE_CLASSES.map((cls) => (
                  <button
                    key={cls}
                    type="button"
                    aria-pressed={m.rideClass === cls}
                    onClick={() => { if (m.rideClass !== cls) void setRideClass(cls); }}
                    className={`mc-btn${m.rideClass === cls ? ' mc-btn-primary' : ''}`}
                  >
                    {label('RideClass', cls)}
                  </button>
                ))}
              </div>
              <p className="mc-muted text-xs mt-3">Set by hand. Confirm the vehicle matches before you change it.</p>
            </section>
          ) : null}

          <section aria-labelledby="earnings" className="mc-card">
            <h2 id="earnings" className="mc-label">Latest earnings</h2>
            {earnings.length === 0 ? (
              <p className="mc-muted">No earnings yet.</p>
            ) : (
              <>
                <ul className="grid gap-1">
                  {earnings.map((e) => (
                    <li key={e.id} className="mc-row">
                      <span>{label('EarningType', e.type)} <span className="mc-muted text-xs">· {when(e.createdAt)}</span></span>
                      <span className="mc-numbers">{gyd(e.amount)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mc-muted text-xs mt-3">
                  Last {earnings.length} entries · {gyd(earned)}. All of it is theirs; Swift only charges the weekly fee.
                </p>
              </>
            )}
          </section>
        </div>

        <div className="space-y-4 min-w-0">
          <section aria-labelledby="vehicle" className="mc-card">
            <h2 id="vehicle" className="mc-label">Vehicle</h2>
            <dl className="mc-rows">
              <Row label="Vehicle">{vehicle || '—'}</Row>
              <Row label="Plate">{m.licensePlate}</Row>
              <Row label="Type">{m.vehicleType ? label('VehicleType', m.vehicleType) : null}</Row>
              {m.vehicleYear ? <Row label="Year">{m.vehicleYear}</Row> : null}
            </dl>
          </section>

          <section aria-labelledby="subscription" className="mc-card">
            <h2 id="subscription" className="mc-label">Subscription</h2>
            {sub ? (
              <dl className="mc-rows">
                <Row label="Status"><StatusBadge group="SubscriptionStatus" value={sub.status} /></Row>
                <Row label="Weekly fee"><span className="mc-numbers">{gyd(sub.customRate ?? sub.weeklyRate)}</span></Row>
                {sub.isTrialActive && sub.trialEndDate ? <Row label="Trial ends">{when(sub.trialEndDate)}</Row> : null}
                {sub.nextBillingDate ? <Row label="Next bill">{when(sub.nextBillingDate)}</Row> : null}
              </dl>
            ) : (
              <p className="mc-muted">No subscription yet. It starts when their documents are verified.</p>
            )}
          </section>

          <section aria-labelledby="performance" className="mc-card">
            <h2 id="performance" className="mc-label">Performance</h2>
            <dl className="mc-rows">
              <Row label="Rating"><span className="mc-numbers">{ratingText(m.averageRating, m.totalRatings)}</span></Row>
              {!isDriver ? <Row label="Deliveries"><span className="mc-numbers">{m.totalDeliveries ?? 0}</span></Row> : null}
              {!isDriver && m.acceptanceRate != null ? <Row label="Acceptance">{`${Math.round(Number(m.acceptanceRate))}%`}</Row> : null}
              {isDriver ? <Row label="Trips"><span className="mc-numbers">{m._count?.orders ?? 0}</span></Row> : null}
              <Row label="Account">{m.user?.id ? <Link href={`/users/${m.user.id}`}><StatusBadge group="UserStatus" value={m.user?.status} /></Link> : null}</Row>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
