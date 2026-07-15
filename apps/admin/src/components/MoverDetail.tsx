'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchRiderDetail,
  fetchDriverDetail,
  verifyRiderDocuments,
  verifyDriverDocuments,
  setDriverRideClass,
} from '@/lib/api';
import { Section, Row, StatusPill, BackLink, ActionButton, gyd } from '@/components/detail';

const RIDE_CLASSES = ['ECONOMY', 'COMFORT', 'XL'];

/** Rider (delivery/courier) and Driver (taxi) drill-downs share one anatomy:
 *  who + vehicle + documents + weekly subscription + latest earnings. */
export function MoverDetail({ id, kind }: { id: string; kind: 'rider' | 'driver' }) {
  const qc = useQueryClient();
  const isDriver = kind === 'driver';
  const { data, isLoading } = useQuery({
    queryKey: [kind, id],
    queryFn: () => (isDriver ? fetchDriverDetail(id) : fetchRiderDetail(id)),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [kind, id] });
    qc.invalidateQueries({ queryKey: [`${kind}s`] });
  };
  const verify = useMutation({
    mutationFn: () => (isDriver ? verifyDriverDocuments(id) : verifyRiderDocuments(id)),
    onSuccess: invalidate,
  });
  const rideClass = useMutation({
    mutationFn: (cls: string) => setDriverRideClass(id, cls),
    onSuccess: invalidate,
  });

  const m: any = data?.data;
  const listHref = isDriver ? '/drivers' : '/riders';
  const listLabel = isDriver ? 'Drivers' : 'Riders';

  if (isLoading) return <div className="h-40 rounded-xl bg-[#1C1C1E] border border-[#38383A] animate-pulse" />;
  if (!m) {
    return (
      <div>
        <BackLink href={listHref} label={listLabel} />
        <p className="text-[#8E8E93]">Not found.</p>
      </div>
    );
  }

  const name = [m.user?.firstName, m.user?.lastName].filter(Boolean).join(' ') || 'Unnamed';
  const vehicle = [m.vehicleColor, m.vehicleMake, m.vehicleModel].filter(Boolean).join(' ');
  const sub = m.subscription;
  const earnings: any[] = m.earnings ?? [];
  const earned = earnings.reduce((a, e) => a + Number(e.amount ?? 0), 0);

  return (
    <div>
      <BackLink href={listHref} label={listLabel} />

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="w-12 h-12 rounded-full bg-[#E8192C] flex items-center justify-center text-lg font-bold">
          {name.charAt(0).toUpperCase()}
        </div>
        <div>
          <h1 className="text-2xl font-bold">{name}</h1>
          <p className="text-sm text-[#8E8E93]">{m.user?.phone}</p>
        </div>
        {m.documentsVerified ? (
          <span className="px-2.5 py-1 rounded-full text-xs bg-emerald-500/15 text-emerald-400">docs verified</span>
        ) : (
          <span className="px-2.5 py-1 rounded-full text-xs bg-amber-500/15 text-amber-400">docs unverified</span>
        )}
        {m.isOnline ? (
          <span className="px-2.5 py-1 rounded-full text-xs bg-emerald-500/15 text-emerald-400">online</span>
        ) : (
          <span className="px-2.5 py-1 rounded-full text-xs bg-white/10 text-[#8E8E93]">offline</span>
        )}
        {isDriver && m.rideClass ? (
          <span className="px-2.5 py-1 rounded-full text-xs bg-sky-500/15 text-sky-400">{m.rideClass}</span>
        ) : null}
        <div className="ml-auto flex gap-2">
          {!m.documentsVerified && (
            <ActionButton
              label="Verify documents"
              confirm={`Verify ${name}'s documents? Their 14-day trial starts now and they can go online.`}
              onClick={() => verify.mutate()}
              disabled={verify.isPending}
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Section title="Latest earnings">
            {earnings.length === 0 ? (
              <p className="text-sm text-[#8E8E93]">No earnings yet.</p>
            ) : (
              <>
                <div className="space-y-2">
                  {earnings.map((e: any) => (
                    <div key={e.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-white/5 text-sm">
                      <span>{String(e.type).replaceAll('_', ' ').toLowerCase()}</span>
                      <span className="text-xs text-[#8E8E93]">{new Date(e.createdAt).toLocaleDateString()}</span>
                      <span className="ml-auto font-medium">{gyd(e.amount)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-[#8E8E93] mt-3">
                  Last {earnings.length} entries · {gyd(earned)} — 100% theirs, Swift only charges the weekly fee.
                </p>
              </>
            )}
          </Section>

          {isDriver && (
            <Section title="Ride class">
              <div className="flex gap-2">
                {RIDE_CLASSES.map((cls) => (
                  <button
                    key={cls}
                    onClick={() => {
                      if (m.rideClass !== cls && window.confirm(`Set ${name}'s ride class to ${cls}?`)) rideClass.mutate(cls);
                    }}
                    disabled={rideClass.isPending}
                    className={`px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 ${
                      m.rideClass === cls ? 'bg-[#E8192C] text-white' : 'border border-[#38383A] text-[#8E8E93] hover:bg-white/10'
                    }`}
                  >
                    {cls}
                  </button>
                ))}
              </div>
              <p className="text-xs text-[#8E8E93] mt-3">
                Class assignment is manual — confirm the vehicle matches before upgrading.
              </p>
            </Section>
          )}
        </div>

        <div className="space-y-4">
          <Section title="Vehicle">
            <div className="space-y-1.5">
              <Row label="Vehicle" value={vehicle || '—'} />
              <Row label="Plate" value={m.licensePlate} />
              {!isDriver && <Row label="Type" value={m.vehicleType?.toLowerCase()} />}
              {!isDriver && <Row label="Rider type" value={m.riderType?.toLowerCase()} />}
              {m.vehicleYear ? <Row label="Year" value={m.vehicleYear} /> : null}
            </div>
          </Section>

          <Section title="Subscription">
            {sub ? (
              <div className="space-y-1.5">
                <Row label="Status" value={<StatusPill value={sub.status} />} />
                <Row label="Weekly rate" value={gyd(sub.customRate ?? sub.weeklyRate)} />
                {sub.isTrialActive && sub.trialEndDate ? <Row label="Trial ends" value={new Date(sub.trialEndDate).toLocaleDateString()} /> : null}
                {sub.nextBillingDate ? <Row label="Next bill" value={new Date(sub.nextBillingDate).toLocaleDateString()} /> : null}
              </div>
            ) : (
              <p className="text-sm text-[#8E8E93]">No subscription yet (starts on verification).</p>
            )}
          </Section>

          <Section title="Performance">
            <div className="space-y-1.5">
              <Row label="Rating" value={m.averageRating ? `${Number(m.averageRating).toFixed(1)} (${m.totalRatings ?? 0})` : '—'} />
              {!isDriver && <Row label="Deliveries" value={m.totalDeliveries} />}
              {!isDriver && <Row label="Acceptance" value={m.acceptanceRate != null ? `${Math.round(Number(m.acceptanceRate))}%` : '—'} />}
              {isDriver && <Row label="Trips" value={m._count?.orders} />}
              <Row label="Joined" value={m.user?.createdAt ? new Date(m.user.createdAt).toLocaleDateString() : '—'} />
              <Row label="Account" value={m.user?.status?.toLowerCase()} href={m.user?.id ? `/users/${m.user.id}` : undefined} />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
