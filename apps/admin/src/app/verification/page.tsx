'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataUnavailable } from '@/components/dashboard/DataUnavailable';
import { MutationError } from '@/components/MutationError';
import { Modal } from '@/components/Modal';
import { DocumentViewer } from '@/components/verification/DocumentViewer';
import { approveDoc, rejectDoc, fetchUserDetail, fetchVerificationCounts, fetchDocumentCustody, type InsuranceCheck } from '@/lib/api';
import { reasonTooShort } from '@/lib/ask-reason';
import { REJECTION_REASONS, SECOND_REVIEW_CODES, isRejectionReasonCode, type RejectionReasonCode } from '@/lib/rejection-reasons';
import { REVIEW_STATUSES, applicantId, docLabel, roleLabel, vehicleLabel, reviewTimeline, groupApplicants, loadReviewQueue, maskedPhone, waitingSince, type Applicant, type ReviewDocument, type ReviewLane, type ReviewStatus } from '@/lib/review-center';

const EXPIRING_DOC_TYPES = [
  'fitness_cert', 'vehicle_insurance', 'hire_car_permit',
  'road_service_licence', 'food_handler_cert', 'gra_restaurant_licence',
  'drivers_licence', 'vehicle_registration',
  // [DOC-1 §18.1] the addendum's annual licences, submittable through a category gate
  'liquor_licence', 'sanitary_certificate', 'trade_licence',
  // [DOC-1 §3.6 · P3-2] the unregistered trader's signed self-declaration — a one-year
  // validity like a licence, so the console must ask for its date too.
  'self_declaration_unregistered',
] as const;
const EMPTY_INSURANCE: InsuranceCheck = { insurerName: '', policyNumber: '', coverageClass: 'HIRE', hireClassConfirmed: false, plateCrossChecked: false };
const LANES = [{ value: 'operator', label: 'Operators' }, { value: 'customer', label: 'Customers' }, { value: 'all', label: 'Everything' }] as const;
function Chip({ status }: { status: string }) { return <span className={`rc-chip rc-chip-${status.toLowerCase()}`}>{status}</span>; }

function TimelineActor({ actor, applicant }: { actor: string | null; applicant: Applicant }) {
  const system = !actor || actor === 'validator' || actor.startsWith('engine:');
  const isApplicant = actor === applicant.id;
  const person = useQuery({ queryKey: ['review-actor', actor], queryFn: () => fetchUserDetail(actor!), enabled: !system && !isApplicant });
  const name = [person.data?.data?.firstName, person.data?.data?.lastName].filter(Boolean).join(' ');
  return <small>{system ? 'System' : isApplicant ? applicant.name : name || (person.isLoading ? 'Loading reviewer…' : 'Reviewer name unavailable')}</small>;
}

export default function VerificationPage() {
  const client = useQueryClient();
  const [status, setStatus] = useState<ReviewStatus>('PENDING');
  const [lane, setLane] = useState<ReviewLane>('operator');
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [role, setRole] = useState('');
  const [type, setType] = useState('');
  const [age, setAge] = useState('');
  const [now, setNow] = useState(Date.now);
  const [applicant, setApplicant] = useState<Applicant | null>(null);
  const [selected, setSelected] = useState<ReviewDocument | null>(null);
  const [viewed, setViewed] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [insurance, setInsurance] = useState<InsuranceCheck>(EMPTY_INSURANCE);
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [reasonCode, setReasonCode] = useState<RejectionReasonCode | ''>('');
  const [notice, setNotice] = useState('');
  const [mutationError, setMutationError] = useState<unknown>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLElement>(null);
  const documentList = useRef<HTMLDivElement>(null);
  const [documentsOverflow, setDocumentsOverflow] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (applicant) { heading.current?.focus({ preventScroll: true }); heading.current?.closest('.rc-applicant')?.scrollIntoView?.({ block: 'start' }); } }, [applicant]);
  useEffect(() => { if (workspace.current) workspace.current.scrollTop = 0; }, [selected?.id]);
  useEffect(() => {
    const pane = workspace.current;
    const footer = actions.current;
    if (!pane) return;
    if (!footer) { pane.style.setProperty('--rc-actions-height', '0px'); return; }
    const reserve = () => pane.style.setProperty('--rc-actions-height', `${footer.getBoundingClientRect().height}px`);
    reserve();
    const observer = new ResizeObserver(reserve);
    observer.observe(footer);
    return () => observer.disconnect();
  }, [applicant?.id, selected?.status]);
  const queue = useQuery({ queryKey: ['verification', status, lane], queryFn: () => loadReviewQueue(status, lane) });
  const counts = useQuery({ queryKey: ['verification-counts'], queryFn: fetchVerificationCounts });
  const profile = useQuery({ queryKey: ['review-profile', applicant?.id], queryFn: () => fetchUserDetail(applicant!.id), enabled: !!applicant });
  const history = useQuery({
    queryKey: ['verification-history', status, lane], enabled: !!applicant,
    queryFn: async () => (await Promise.all(REVIEW_STATUSES.filter((s) => s !== status).map((s) => loadReviewQueue(s, lane)))).flat(),
  });
  const custody = useQuery({ queryKey: ['document-custody', selected?.id], queryFn: () => fetchDocumentCustody(selected!.id), enabled: !!selected });
  const timeline = reviewTimeline(custody.data?.data?.timeline ?? []);
  const groups = groupApplicants(queue.data ?? []);
  const filtered = groups.filter((a) => {
    const q = search.trim().toLowerCase();
    return (!q || `${a.name} ${a.phone}`.toLowerCase().includes(q)) &&
      (!age || (a.oldest > 0 && now - a.oldest >= Number(age) * 3_600_000)) &&
      a.documents.some((d) => (!role || d.role === role) && (!type || d.docType === type));
  });
  const documents = applicant ? [...new Map([
    ...applicant.documents, ...(history.data ?? []).filter((d) => applicantId(d) === applicant.id),
    ...(queue.data ?? []).filter((d) => applicantId(d) === applicant.id),
  ].map((d) => [d.id, d])).values()] : [];
  useEffect(() => {
    const list = documentList.current;
    if (!list) return;
    const measure = () => setDocumentsOverflow(list.scrollWidth > list.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const card of Array.from(list.children)) observer.observe(card);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [applicant?.id, documents.length]);
  const backToDocuments = () => {
    if (workspace.current) workspace.current.scrollTop = 0;
    documentList.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  };
  const selectDocument = (doc: ReviewDocument) => {
    setSelected(doc); setViewed(false); setExpiresAt(''); setDocumentNumber(''); setIssuedOn(''); setInsurance(EMPTY_INSURANCE);
    setMutationError(null); setDecision(null); setReason(''); setReasonCode('');
  };
  const openApplicant = (next: Applicant | null) => {
    setApplicant(next);
    if (next) selectDocument(next.documents[0]!); else setSelected(null);
  };
  // [MC-PR1] /verification?applicant=<userId>: "Open in Review Center" on a
  // refusal (a store whose documents are not all approved) lands on THAT
  // applicant's file, once; from there the reviewer browses as usual. When
  // nothing of theirs is waiting, the page says so instead of showing the
  // whole queue as if it were the answer.
  const deepLink = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (deepLink.current === undefined) deepLink.current = new URLSearchParams(window.location.search).get('applicant');
    const wanted = deepLink.current;
    if (!wanted || !queue.data) return;
    deepLink.current = null;
    const match = groupApplicants(queue.data).find((a) => a.id === wanted);
    if (match) openApplicant(match);
    else setNotice('No documents from this applicant are waiting for review. They may still need to upload one, or the decision is under Approved, Rejected or Expired.');
  }, [queue.data]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once per queue load by design
  const needsExpiry = !!selected && (EXPIRING_DOC_TYPES as readonly string[]).includes(selected.docType);
  const expiryOk = !needsExpiry || (!!expiresAt && Date.parse(expiresAt) > now);
  const isInsurance = selected?.docType === 'vehicle_insurance';
  const insuranceReady = insurance.insurerName.trim() && insurance.policyNumber.trim() &&
    (insurance.coverageClass !== 'HIRE' || (insurance.hireClassConfirmed && insurance.plateCrossChecked));
  const needsNumber = selected?.reviewerTypes?.includes('documentNumber') ?? false;
  const needsIssuedOn = selected?.reviewerTypes?.includes('issuedOn') ?? false;
  const typedReady = (!needsNumber || documentNumber.replace(/[^a-z0-9]/gi, '').length >= 4)
    && (!needsIssuedOn || (!!issuedOn && Number.isFinite(Date.parse(issuedOn)) && Date.parse(issuedOn) <= now));
  const approveBlocked = !viewed || !expiryOk || !typedReady || (isInsurance && !insuranceReady);
  const currentIndex = filtered.findIndex((a) => a.id === applicant?.id);
  const move = (offset: number) => {
    const next = filtered[currentIndex + offset];
    if (next) openApplicant(next);
  };
  const mutation = useMutation({
    mutationFn: async ({ action, doc, note, code }: { action: 'approve' | 'reject'; doc: ReviewDocument; note: string; code: RejectionReasonCode | '' }) => {
      if (action === 'reject' && !code) throw new Error('Choose a reason code.');
      return action === 'approve' ? approveDoc(doc.id, {
        ...(needsExpiry ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        ...(isInsurance ? { insurance } : {}),
        ...(needsNumber ? { documentNumber: documentNumber.trim() } : {}),
        ...(needsIssuedOn ? { issuedOn: new Date(issuedOn).toISOString() } : {}),
      }, note) : rejectDoc(doc.id, note, code as RejectionReasonCode);
    },
    onError: (error) => setMutationError(error),
    onSuccess: async (result, variables) => {
      const outcome = result?.data?.status;
      setNotice(outcome === 'PENDING'
        ? 'Sent for a second review: a different reviewer must confirm it. It is not rejected until they do.'
        : outcome === 'APPROVED' ? `Approved ${docLabel(variables.doc.docType)} for ${applicant?.name}.`
        : outcome === 'REJECTED' ? `Rejected ${docLabel(variables.doc.docType)} for ${applicant?.name}.`
        : 'Decision received. Refreshing the server record; no final status was returned.');
      const nextApplicant = filtered[currentIndex + 1] ?? null;
      setDecision(null);
      // No optimistic decision or removal: invalidate the reads after the response.
      await Promise.all([
        client.invalidateQueries({ queryKey: ['verification'] }),
        client.invalidateQueries({ queryKey: ['verification-history'] }),
        client.invalidateQueries({ queryKey: ['verification-counts'] }),
        client.invalidateQueries({ queryKey: ['document-custody', variables.doc.id] }),
      ]);
      openApplicant(nextApplicant);
    },
    onSettled: () => { inFlight.current = false; },
  });
  const busy = mutation.isPending;
  const openDecision = (action: 'approve' | 'reject') => {
    if (!selected || selected.status !== 'PENDING' || busy || (action === 'approve' && approveBlocked)) return;
    setReason(''); setReasonCode(''); setMutationError(null); setDecision(action);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (!applicant || busy || decision || event.ctrlKey || event.metaKey || event.altKey || event.repeat ||
        target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]') || document.querySelector('[role="dialog"]')) return;
      switch (event.key.toLowerCase()) {
        case 'j': event.preventDefault(); move(1); break;
        case 'k': event.preventDefault(); move(-1); break;
        case 'a': event.preventDefault(); openDecision('approve'); break;
        case 'r': event.preventDefault(); openDecision('reject'); break;
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const laneCounts = counts.data?.data?.byLane?.[status];
  const vehicle = profile.data?.data?.driver ?? selected?.user?.driver;
  const rider = profile.data?.data?.rider;
  const businesses: { id?: string; name: string }[] = profile.data?.data?.vendorOwner?.vendors ?? [];
  const clearFilters = () => { setSearch(''); setRole(''); setType(''); setAge(''); };
  return <div className={`review-center${applicant ? ' rc-is-review' : ''}`}>
    <div inert={decision ? true : undefined}>
      <header className="rc-page-heading"><div><h1>Review Center</h1><p>Review the evidence. Record the decision. Keep applicants moving.</p></div><span className="rc-muted">Oldest submissions first</span></header>
      {notice && <p role="status" className="rc-notice">{notice}</p>}
      <div className="rc-queue-controls">
        <div className="rc-tabs" aria-label="Document status">{REVIEW_STATUSES.map((s) => <button key={s} disabled={busy} aria-pressed={s === status} onClick={() => { setStatus(s); openApplicant(null); }}>{s}</button>)}</div>
        <div className="rc-tabs" aria-label="Review lane">{LANES.map((l) => <button key={l.value} disabled={busy} aria-pressed={l.value === lane} onClick={() => { setLane(l.value); openApplicant(null); clearFilters(); }}>
          {l.label}<span aria-hidden="true"> {laneCounts ? (l.value === 'all' ? laneCounts.operator + laneCounts.customer : laneCounts[l.value]) : '—'}</span>
        </button>)}</div>
        {counts.isError && <p className="rc-muted">Lane counts unavailable. <button onClick={() => void counts.refetch()}>Retry counts</button></p>}
        {lane !== 'operator' && <p className="rc-muted">Customer IDs are shown deliberately in this lane. Every document view is audit-logged.</p>}
      </div>
      {!applicant ? <>
        <button className="rc-filter-toggle" aria-expanded={filtersOpen} aria-controls="review-filters" onClick={() => setFiltersOpen(!filtersOpen)}>Filters{search || role || type || age ? " · active" : ""}</button>
        <div id="review-filters" className={`rc-filters${filtersOpen ? " rc-filters-open" : ""}`}>
          <label>Search applicants<input aria-label="Search applicants" type="search" placeholder="Name or phone" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <label>Applicant role<select aria-label="Applicant role" value={role} onChange={(e) => setRole(e.target.value)}><option value="">All roles</option>{[...new Set(['CUSTOMER', ...(queue.data ?? []).map((d) => d.role)])].sort().map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></label>
          <label>Document type<select aria-label="Document type" value={type} onChange={(e) => setType(e.target.value)}><option value="">All documents</option>{[...new Set((queue.data ?? []).map((d) => d.docType))].sort().map((t) => <option key={t} value={t}>{docLabel(t)}</option>)}</select></label>
          <label>Waiting time<select aria-label="Waiting time" value={age} onChange={(e) => setAge(e.target.value)}><option value="">Any age</option><option value="24">Over 24 hours</option><option value="72">Over 3 days</option><option value="168">Over 7 days</option></select></label>
          <button onClick={clearFilters}>Clear filters</button>
        </div>
        {queue.isLoading ? <div className="rc-skeleton" aria-label="Loading verification queue">Loading the complete queue…</div> : queue.isError ? <DataUnavailable what="the verification queue" notAnAllClear="This is not an empty queue — we could not read it." onRetry={() => void queue.refetch()} /> : <section className="rc-queue" aria-label="Applicants">
          <div className="rc-queue-summary"><strong>{filtered.length} applicants</strong><span>{queue.data?.length ?? 0} documents in this lane</span><button onClick={() => void queue.refetch()} disabled={queue.isFetching}>Refresh queue</button></div>
          {!filtered.length ? <p className="rc-empty"><span>{groups.length ? 'No applicants match these filters.' : 'No documents'}</span> {groups.length ? 'Clear a filter to see more applicants.' : 'This lane has no documents with the selected status.'}</p> :
            <table className="rc-queue-table"><thead><tr><th>Applicant</th><th>Role / documents</th><th>Waiting for</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{filtered.map((a) => <tr key={a.id}>
              <td><strong>{a.name}</strong><small>{maskedPhone(a.phone)}</small></td>
              <td><span>{[...new Set(a.documents.map((d) => roleLabel(d.role)))].join(', ')}</span><small>{a.documents.length} {a.documents.length === 1 ? 'document' : 'documents'} · {a.documents.map((d) => docLabel(d.docType)).join(', ')}</small></td>
              <td><time dateTime={a.oldest ? new Date(a.oldest).toISOString() : undefined}>{waitingSince(a.oldest, now)}</time></td>
              <td><button className="rc-primary" onClick={() => openApplicant(a)}>Review</button></td>
            </tr>)}</tbody></table>}
        </section>}
      </> : selected && <section className="rc-applicant" aria-label="Applicant review">
        <div className="rc-applicant-navigation"><button disabled={busy} onClick={() => openApplicant(null)}>Back to queue</button><div><button disabled={busy || currentIndex <= 0} onClick={() => move(-1)}>Previous applicant</button><button disabled={busy || currentIndex < 0 || currentIndex >= filtered.length - 1} onClick={() => move(1)}>Next applicant</button></div></div>
        <header className="rc-applicant-heading"><div><h2 ref={heading} tabIndex={-1}>{applicant.name}</h2><p>{maskedPhone(applicant.phone)} · {[...new Set(documents.map((d) => roleLabel(d.role)))].join(', ')} · {selected.user?.countryCode}</p>
          {businesses.map((b, i) => <p key={b.id ?? i}>{b.name}</p>)}
          {vehicle && <p>Vehicle on file: <strong>{vehicle.licensePlate ?? 'No plate on file'}</strong> · {[[vehicle.vehicleMake, vehicle.vehicleModel].filter(Boolean).join(' '), vehicle.vehicleType ? vehicleLabel(vehicle.vehicleType) : ''].filter(Boolean).join(' · ')}</p>}
          {rider && <p>Rider: {rider.vehicleType ? vehicleLabel(rider.vehicleType) : 'Vehicle not recorded'}</p>}
          {profile.isError && <p className="rc-error">Profile facts could not be loaded. <button onClick={() => void profile.refetch()}>Retry profile</button></p>}
        </div><span className="rc-muted">{waitingSince(applicant.oldest, now)}</span></header>
        <button className="rc-back-documents" onClick={backToDocuments}>Back to documents and zoom · {documents.findIndex((d) => d.id === selected.id) + 1} of {documents.length}</button>
        <div ref={workspace} className="rc-workspace">
          <nav className="rc-documents" aria-label="Applicant documents"><h3>Documents in this lane <span>{documents.findIndex((d) => d.id === selected.id) + 1} of {documents.length}</span></h3>
            {documentsOverflow && <p className="rc-document-cue">Swipe to see more documents</p>}
            {history.isLoading && <p className="rc-muted">Loading other statuses…</p>}
            {history.isError && <p className="rc-error">Other document statuses could not be loaded. <button onClick={() => void history.refetch()}>Retry documents</button></p>}
            <div ref={documentList} className="rc-document-list">{documents.map((d) => <button key={d.id} disabled={busy} aria-pressed={selected.id === d.id} onClick={() => selectDocument(d)}><span>{docLabel(d.docType)}</span><Chip status={d.status} /></button>)}</div>
          </nav>
          <div className="rc-review-body">
            <div className="rc-document-heading"><h3>{docLabel(selected.docType)}</h3><Chip status={selected.status} /></div>
            <DocumentViewer key={selected.id} id={selected.id} label={docLabel(selected.docType)} onViewed={setViewed} onRejectMissing={selected.status === 'PENDING' && !busy ? () => { openDecision('reject'); setReasonCode('UNREADABLE'); } : undefined} />
            <div className="rc-review-facts"><span>Consent: {selected.consentAt ? `notice ${selected.privacyNoticeVersion ?? ''}` : 'none on file'}</span>{selected.expiresAt && <span>Recorded expiry: {new Date(selected.expiresAt).toLocaleDateString()}</span>}</div>
            {selected.status === 'PENDING' && (needsExpiry || isInsurance || needsNumber || needsIssuedOn) && <div className="rc-fields">
              {needsNumber && <label>Document number<input aria-label="Document number" autoComplete="off" maxLength={40} value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} disabled={busy} /><small>Read the number from this document.</small></label>}
              {needsIssuedOn && <label>Issue date printed on the document<input type="date" aria-label="Issue date printed on the document" max={new Date(now).toISOString().slice(0, 10)} value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} disabled={busy} /><small>Read its issue date. The server determines when it must be checked again.</small></label>}
              {needsExpiry && <label>Expiry printed on the document (required)<input type="date" aria-label="Expiry printed on the document" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} disabled={busy} />{!expiryOk && <small>{expiresAt ? 'That date has already passed; an expired document cannot be approved.' : 'This document type expires — key the date from the document.'}</small>}</label>}
              {isInsurance && <fieldset disabled={busy}><legend>Insurance 5-point check</legend>
                <label>Insurer<input placeholder="Insurer" value={insurance.insurerName} onChange={(e) => setInsurance({ ...insurance, insurerName: e.target.value })} /></label>
                <label>Policy number<input placeholder="Policy number" value={insurance.policyNumber} onChange={(e) => setInsurance({ ...insurance, policyNumber: e.target.value })} /></label>
                <label>Coverage class<select value={insurance.coverageClass} onChange={(e) => setInsurance({ ...insurance, coverageClass: e.target.value as 'HIRE' | 'PRIVATE' })}><option value="HIRE">HIRE class</option><option value="PRIVATE">PRIVATE class</option></select></label>
                <label className="rc-check"><input type="checkbox" checked={insurance.hireClassConfirmed} onChange={(e) => setInsurance({ ...insurance, hireClassConfirmed: e.target.checked })} />Hire class confirmed (required for live rides)</label>
                <label className="rc-check"><input type="checkbox" checked={insurance.plateCrossChecked} onChange={(e) => setInsurance({ ...insurance, plateCrossChecked: e.target.checked })} />Cross-checked against the H-plate</label>
              </fieldset>}
            </div>}
            <section className="rc-history"><h3>History and audit timeline</h3>
              {custody.isLoading ? <p>Loading history…</p> : custody.isError ? <p className="rc-error">History unavailable. <button onClick={() => void custody.refetch()}>Retry history</button></p> : timeline.length ?
                <ol>{timeline.map((event, i) => <li key={`${event.at}-${i}`}><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time><span>{event.label}</span><TimelineActor actor={event.actor} applicant={applicant} /></li>)}</ol> : <p className="rc-muted">No history returned for this document.</p>}
            </section>
          </div>
        </div>
        {selected.status === 'PENDING' && <footer ref={actions} className="rc-actions"><p>{viewed ? 'Evidence opened. Record your decision.' : 'Open the evidence to unlock approval.'}<small>Desktop: A approve · R reject · J/K navigate</small></p><button disabled={busy} onClick={() => openDecision('reject')}>Reject</button><button className="rc-primary" disabled={busy || !!approveBlocked} onClick={() => openDecision('approve')}>Approve</button></footer>}
      </section>}
    </div>
    {decision && selected && applicant && <Modal title={decision === 'approve' ? 'Approve document' : 'Reject document'} busy={busy} onClose={() => setDecision(null)}>
      <h2>{decision === 'approve' ? 'Approve' : 'Reject'} {docLabel(selected.docType)}</h2><p>For {applicant.name}. This changes their operating eligibility.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (inFlight.current || busy || reasonTooShort(reason) || reason.trim().length > 500 || (decision === 'reject' && !reasonCode) || (decision === 'approve' && approveBlocked)) return;
        inFlight.current = true; setMutationError(null);
        mutation.mutate({ action: decision, doc: selected, note: reason.trim(), code: reasonCode });
      }}>
        {decision === 'reject' && <label>Reason code<select aria-label="Reason code" value={reasonCode} disabled={busy} onChange={(e) => setReasonCode(isRejectionReasonCode(e.target.value) ? e.target.value : '')}><option value="">Choose why it is rejected…</option>{REJECTION_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label} ({r.code})</option>)}</select></label>}
        {decision === 'reject' && reasonCode && SECOND_REVIEW_CODES.has(reasonCode) && <p className="rc-notice">This does not reject it yet: a different reviewer must confirm it on the second-review queue. The applicant is only told the document could not be verified.</p>}
        <label>Decision note<textarea aria-label="Decision note" placeholder={decision === 'reject' ? 'Rejection reason' : 'Why this document is valid'} rows={4} maxLength={500} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label>
        <p className="rc-muted">At least 12 characters. Your note is kept in the review record.</p>
        <MutationError error={mutationError} label="Verification action failed" />
        <div className="rc-dialog-actions"><button type="button" disabled={busy} onClick={() => setDecision(null)}>Cancel</button><button className="rc-primary" type="submit" disabled={busy || reasonTooShort(reason) || (decision === 'reject' && !reasonCode) || (decision === 'approve' && !!approveBlocked)}>{busy ? 'Saving decision…' : decision === 'approve' ? 'Confirm approval' : 'Confirm rejection'}</button></div>
      </form>
    </Modal>}
  </div>;
}
