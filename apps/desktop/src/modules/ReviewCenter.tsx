import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  documentViewUrl,
  fetchReviewApplicant,
  fetchReviewQueue,
  REASON_CODES,
  type ReviewApplicantRecord,
  type ReviewDoc,
} from '../lib/api';

type DecisionPanel = 'approve' | 'reject' | null;

const pretty = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const applicantName = (doc: ReviewDoc) =>
  [doc.user?.firstName, doc.user?.lastName].filter(Boolean).join(' ') || doc.user?.phone || 'Unknown applicant';

function todayInGuyana(): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Guyana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function EmptyFeed({ children }: { children: ReactNode }) {
  return <div className="empty-feed">{children}</div>;
}

function ApplicantSourceRecord({
  doc,
  record,
  state,
  error,
}: {
  doc: ReviewDoc;
  record?: ReviewApplicantRecord;
  state: 'loading' | 'error' | 'ready';
  error?: Error | null;
}) {
  if (state === 'loading') {
    return <div className="source-record source-record-loading">Loading the applicant record…</div>;
  }
  if (state === 'error' || !record) {
    return (
      <div className="source-record source-record-error">
        <strong>Applicant record unavailable</strong>
        <span>{error?.message ?? 'This document cannot be approved until the source record is available.'}</span>
      </div>
    );
  }

  const applicant = (
    <div>
      <span>Applicant record</span>
      <strong>{[record.firstName, record.lastName].filter(Boolean).join(' ') || record.phone}</strong>
      <small>{record.phone}</small>
    </div>
  );
  const role = doc.role.toUpperCase();

  if (role === 'VENDOR_OWNER') {
    const vendors = record.vendorOwner?.vendors ?? [];
    return (
      <section className="source-record" aria-label="Applicant and business source record">
        {applicant}
        {vendors.length > 0 ? vendors.map((vendor) => (
          <div key={vendor.id}>
            <span>Business source record</span>
            <strong>{vendor.name}</strong>
            <small>{pretty(vendor.vendorType)} · {pretty(vendor.status)}{vendor.city ? ` · ${vendor.city}` : ''}</small>
          </div>
        )) : (
          <div className="source-record-gap">
            <span>Business source record</span>
            <strong>No associated business returned</strong>
            <small>The owner endpoint has no business context for this review.</small>
          </div>
        )}
        {vendors.length > 1 && (
          <div className="source-record-gap">
            <span>Document linkage gap</span>
            <strong>{vendors.length} businesses share this owner</strong>
            <small>The verification row does not identify which business this file belongs to.</small>
          </div>
        )}
      </section>
    );
  }

  if (role === 'CUSTOMER') {
    const isLevelTwoIdentity = doc.docType.toLowerCase() === 'identity_l2';
    return (
      <section className="source-record" aria-label="Applicant source record">
        {applicant}
        <div className="source-record-gap">
          <span>{isLevelTwoIdentity ? 'Identity comparison source' : 'Service-provider source record'}</span>
          <strong>Not exposed by the current admin contract</strong>
          <small>
            {isLevelTwoIdentity
              ? 'The queue does not expose the submitted selfie or KYC comparison evidence.'
              : 'Trade and qualification context require an API contract before this review can be completed here.'}
          </small>
        </div>
      </section>
    );
  }

  const vehicles = [
    record.driver ? { kind: 'Passenger profile', profile: record.driver } : null,
    record.rider ? { kind: 'Delivery profile', profile: record.rider } : null,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return (
    <section className="source-record" aria-label="Applicant source record">
      {applicant}
      {vehicles.length > 0 ? vehicles.map(({ kind, profile }) => (
        <div key={kind}>
          <span>{kind}</span>
          <strong>
            {[profile.vehicleColor, profile.vehicleMake, profile.vehicleModel].filter(Boolean).join(' ') || profile.vehicleType}
          </strong>
          <small>{profile.licensePlate?.trim() ? `Plate ${profile.licensePlate.trim()}` : 'Plate unavailable'}</small>
        </div>
      )) : (
        <div>
          <span>Vehicle record</span>
          <strong>No mover vehicle profile returned</strong>
          <small>Vehicle comparison cannot be prepared for this document.</small>
        </div>
      )}
    </section>
  );
}

function waitingLabel(iso: string): { short: string; detail: string; breaching: boolean } {
  const submitted = new Date(iso).getTime();
  if (!Number.isFinite(submitted)) return { short: 'Unknown', detail: 'Submission time unavailable', breaching: false };
  const hours = Math.max(0, Math.floor((Date.now() - submitted) / 3_600_000));
  if (hours < 1) return { short: '<1h', detail: 'Submitted within the last hour', breaching: false };
  if (hours < 24) return { short: `${hours}h`, detail: `Waiting ${hours} hours`, breaching: false };
  const days = Math.floor(hours / 24);
  return { short: `${days}d`, detail: `Waiting ${days} day${days === 1 ? '' : 's'}`, breaching: true };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="textbox"], [data-shortcuts-off]'));
}

function DocumentFrame({ docId }: { docId: string }) {
  const url = useQuery({
    queryKey: ['document-preview', docId, 'inline'],
    queryFn: () => documentViewUrl(docId),
    staleTime: 0,
    gcTime: 0,
  });

  if (url.isLoading) {
    return <div className="document-frame-state">Minting a fresh audited preview…</div>;
  }
  if (url.isError) {
    return (
      <div className="document-frame-state document-frame-error">
        <strong>Preview unavailable</strong>
        <span>{(url.error as Error).message}</span>
      </div>
    );
  }

  return (
    <iframe
      src={url.data}
      title="Document preview"
      sandbox="allow-same-origin"
      tabIndex={-1}
      className="document-frame inline-document-frame"
    />
  );
}

function FullScreenPreview({
  doc,
  sequence,
  onClose,
}: {
  doc: ReviewDoc;
  sequence: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const url = useQuery({
    queryKey: ['document-preview', doc.id, 'full-screen', sequence],
    queryFn: () => documentViewUrl(doc.id),
    staleTime: 0,
    gcTime: 0,
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const shellWasInert = shell?.inert ?? false;
    const previousAriaHidden = shell?.getAttribute('aria-hidden') ?? null;

    if (shell) {
      shell.inert = true;
      shell.setAttribute('aria-hidden', 'true');
    }
    requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));

    return () => {
      if (shell) {
        const commandStillOpen = Boolean(document.querySelector('.command-scrim'));
        shell.inert = shellWasInert || commandStillOpen;
        if (previousAriaHidden === null && !commandStillOpen) shell.removeAttribute('aria-hidden');
        else shell.setAttribute('aria-hidden', previousAriaHidden ?? 'true');
      }
      requestAnimationFrame(() => opener?.focus({ preventScroll: true }));
    };
  }, []);

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === ' ') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), iframe, [href]',
    ) ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal((
    <div
      ref={dialogRef}
      className="quick-look"
      role="dialog"
      aria-modal="true"
      aria-label={`${pretty(doc.docType)} full-screen preview`}
      aria-describedby="quick-look-help"
      onKeyDown={onDialogKeyDown}
      onMouseDown={onClose}
    >
      <span className="focus-guard" tabIndex={0} onFocus={() => closeButtonRef.current?.focus()} />
      <div className="quick-look-window" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">Audited preview</p>
            <strong>{pretty(doc.docType)} · {applicantName(doc)}</strong>
          </div>
          <button ref={closeButtonRef} className="icon-button inverse" onClick={onClose} aria-label="Close full-screen preview">×</button>
        </header>
        <div className="quick-look-body">
          {url.isLoading && <div className="document-frame-state">Minting a fresh audited preview…</div>}
          {url.isError && (
            <div className="document-frame-state document-frame-error">
              <strong>Preview unavailable</strong>
              <span>{(url.error as Error).message}</span>
            </div>
          )}
          {url.data && <iframe src={url.data} title="Full-screen document preview" sandbox="allow-same-origin" className="document-frame" />}
        </div>
        <footer id="quick-look-help">Space or Esc closes while Mission Control has focus · each open records a fresh five-minute link</footer>
      </div>
      <span className="focus-guard" tabIndex={0} onFocus={() => closeButtonRef.current?.focus()} />
    </div>
  ), document.body);
}

function ApprovePanel({
  doc,
  record,
  recordState,
  onCancel,
}: {
  doc: ReviewDoc;
  record?: ReviewApplicantRecord;
  recordState: 'loading' | 'error' | 'ready';
  onCancel: () => void;
}) {
  const isInsurance = doc.docType.toLowerCase() === 'vehicle_insurance';
  const role = doc.role.toUpperCase();
  const vehicleCandidates = [record?.driver, record?.rider].filter(
    (profile): profile is NonNullable<typeof profile> => Boolean(profile),
  );
  const vehicle = role === 'DRIVER'
    ? record?.driver
    : role === 'RIDER'
      ? record?.rider
      : vehicleCandidates.length === 1 ? vehicleCandidates[0] : null;
  const normalizedPlate = vehicle?.licensePlate?.trim() ?? '';
  const passengerVehicleTypes = new Set(['CAR', 'WAGON_CAR', 'BUS_9', 'BUS_15']);
  const isPassengerInsurance = isInsurance && Boolean(vehicle && passengerVehicleTypes.has(vehicle.vehicleType));
  const vehicleAmbiguous = role === 'MOVER' && vehicleCandidates.length > 1;
  const [expiresAt, setExpiresAt] = useState('');
  const [insurerName, setInsurerName] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [coverageClass, setCoverageClass] = useState<'' | 'HIRE' | 'PRIVATE'>('');
  const [hireConfirmed, setHireConfirmed] = useState(false);
  const [plateChecked, setPlateChecked] = useState(false);
  const [humanConfirmed, setHumanConfirmed] = useState(false);

  const recordReady = recordState === 'ready' && record?.id === doc.user?.id;
  const today = todayInGuyana();
  const expiryInvalid = Boolean(expiresAt && expiresAt < today);
  const insuranceBlocked = isInsurance && (
    !expiresAt
    || expiresAt < today
    || insurerName.trim().length === 0
    || policyNumber.trim().length === 0
    || !coverageClass
    || !recordReady
    || !normalizedPlate
    || vehicleAmbiguous
    || !plateChecked
    || (coverageClass === 'HIRE' && !hireConfirmed)
    || (isPassengerInsurance && coverageClass !== 'HIRE')
  );
  const worksheetComplete = humanConfirmed && recordReady && !expiryInvalid && !insuranceBlocked;

  return (
    <section className="decision-panel approve-panel" aria-label="Approve document">
      <header>
        <div>
          <p className="eyebrow">Human decision</p>
          <h4>Approve {pretty(doc.docType)}</h4>
        </div>
        <button className="quiet-button" onClick={onCancel}>Cancel</button>
      </header>
      <div className="decision-fields">
        <label>
          <span>
            Expiry shown on document
            <small>{isInsurance ? 'required · valid through that printed day in Guyana' : 'optional when none exists'}</small>
          </span>
          <input type="date" min={today} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </label>
        {isInsurance && (
          <div className="insurance-gate">
            <div className="gate-heading">
              <span aria-hidden="true">!</span>
              <div>
                <strong>Liability gate · blocking</strong>
                <small>
                  {isPassengerInsurance
                    ? 'Taxi work requires confirmed HIRE / passenger cover.'
                    : 'Coverage, expiry and the recorded plate must be checked.'}
                </small>
              </div>
            </div>
            <div className="field-grid">
              <label>
                <span>Insurer name</span>
                <input value={insurerName} onChange={(event) => setInsurerName(event.target.value)} />
              </label>
              <label>
                <span>Policy number</span>
                <input value={policyNumber} onChange={(event) => setPolicyNumber(event.target.value)} />
              </label>
              <label>
                <span>Coverage class</span>
                <select value={coverageClass} onChange={(event) => setCoverageClass(event.target.value as '' | 'HIRE' | 'PRIVATE')}>
                  <option value="">Choose from the policy</option>
                  <option value="HIRE">HIRE / passenger coverage</option>
                  <option value="PRIVATE">PRIVATE {isPassengerInsurance ? '· cannot approve for taxi' : '· delivery/cargo only'}</option>
                </select>
              </label>
            </div>
            {(coverageClass === 'HIRE' || isPassengerInsurance) && (
              <label className="check-row">
                <input type="checkbox" checked={hireConfirmed} onChange={(event) => setHireConfirmed(event.target.checked)} />
                <span>I confirmed that the policy covers hire/passenger use.</span>
              </label>
            )}
            <label className="check-row">
              <input type="checkbox" checked={plateChecked} onChange={(event) => setPlateChecked(event.target.checked)} />
              <span>
                The policy plate matches the source record shown above
                {normalizedPlate ? ` (${normalizedPlate})` : ''}.
              </span>
            </label>
          </div>
        )}
        <label className="check-row human-check">
          <input
            type="checkbox"
            checked={humanConfirmed}
            disabled={!recordReady}
            onChange={(event) => setHumanConfirmed(event.target.checked)}
          />
          <span>I reviewed this document against the source fields shown above. This approval is my decision.</span>
        </label>
        {!recordReady && (
          <p className="decision-blocker">Approval stays blocked until the applicant source record is available.</p>
        )}
        {vehicleAmbiguous && isInsurance && (
          <p className="decision-blocker">
            Approval stays blocked because this MOVER record has multiple vehicle profiles and the document API does not identify which one the policy covers.
          </p>
        )}
      </div>
      <p className="decision-contract-gap">
        Recording is disabled: the API can commit this transition before its audit row, and it does not snapshot the reviewed plate/profile.
      </p>
      <button className="approve-button" disabled title={worksheetComplete ? 'Server audit contract required' : 'Complete the review worksheet first'}>
        Approval unavailable · audit contract required
      </button>
    </section>
  );
}

function RejectPanel({
  doc,
  onCancel,
}: {
  doc: ReviewDoc;
  onCancel: () => void;
}) {
  const [code, setCode] = useState<'' | (typeof REASON_CODES)[number]>('');
  const [reason, setReason] = useState('');
  const validReason = reason.trim().length >= 3 && reason.trim().length <= 500 && Boolean(code);

  return (
    <section className="decision-panel reject-panel" aria-label="Reject document">
      <header>
        <div>
          <p className="eyebrow">Human decision</p>
          <h4>Reject {pretty(doc.docType)}</h4>
        </div>
        <button className="quiet-button" onClick={onCancel}>Cancel</button>
      </header>
      <div className="reason-codes" aria-label="Reject reason category">
        {REASON_CODES.map((reasonCode) => (
          <button
            key={reasonCode}
            className={code === reasonCode ? 'active' : ''}
            onClick={() => setCode(reasonCode)}
            type="button"
            aria-pressed={code === reasonCode}
          >
            {pretty(reasonCode)}
          </button>
        ))}
      </div>
      <label className="reason-field">
        <span>
          Specific reason for the applicant
          <small>{reason.length}/500</small>
        </span>
        <textarea
          autoFocus
          value={reason}
          maxLength={500}
          rows={3}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Say exactly what must be corrected before they upload again."
        />
      </label>
      <p className="decision-contract-gap">
        Recording is disabled: rejection and its audit record are not committed atomically by the current API.
      </p>
      <button className="reject-button" disabled title={validReason ? 'Server audit contract required' : 'Choose a category and write a specific reason'}>
        Rejection unavailable · audit contract required
      </button>
    </section>
  );
}

function PageCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      aria-label="Select every document on this page"
    />
  );
}

export default function ReviewCenter() {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [panel, setPanel] = useState<DecisionPanel>(null);
  const [previewDoc, setPreviewDoc] = useState<ReviewDoc | null>(null);
  const [previewSequence, setPreviewSequence] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  const queue = useQuery({
    queryKey: ['review-queue', page],
    queryFn: () => fetchReviewQueue('PENDING', page),
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => queue.data?.rows ?? [], [queue.data?.rows]);
  const currentIndex = rows.findIndex((row) => row.id === activeId);
  const current = currentIndex >= 0 ? rows[currentIndex] : undefined;
  const look = previewDoc !== null;
  const applicantRecord = useQuery({
    queryKey: ['review-applicant', current?.user?.id],
    queryFn: () => fetchReviewApplicant(current!.user!.id),
    enabled: Boolean(current?.user?.id),
    staleTime: 0,
  });
  const applicantRecordState: 'loading' | 'error' | 'ready' = !current?.user?.id
    ? 'error'
    : applicantRecord.isLoading ? 'loading' : applicantRecord.isError ? 'error' : 'ready';

  useEffect(() => {
    if (rows.length === 0) {
      setActiveId(null);
      setPanel(null);
      return;
    }
    if (!activeId || !rows.some((row) => row.id === activeId)) {
      setActiveId(rows[0].id);
      setPanel(null);
    }
  }, [activeId, rows]);

  useEffect(() => {
    const visible = new Set(rows.map((row) => row.id));
    setSelected((previous) => new Set([...previous].filter((id) => visible.has(id))));
  }, [rows]);

  useEffect(() => {
    const lastPage = Math.max(1, queue.data?.meta.totalPages ?? 1);
    if (page > lastPage) setPage(lastPage);
  }, [page, queue.data?.meta.totalPages]);

  useEffect(() => {
    if (!activeId) return;
    tableRef.current?.querySelector(`[data-document-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  useEffect(() => {
    if (previewDoc && !rows.some((row) => row.id === previewDoc.id)) setPreviewDoc(null);
  }, [previewDoc, rows]);

  const move = useCallback((delta: number, focusRow = false) => {
    if (rows.length === 0) return;
    const from = currentIndex >= 0 ? currentIndex : 0;
    const next = Math.max(0, Math.min(rows.length - 1, from + delta));
    const nextId = rows[next].id;
    setActiveId(nextId);
    setPanel(null);
    setNotice(null);
    if (focusRow) {
      requestAnimationFrame(() => {
        tableRef.current
          ?.querySelector<HTMLElement>(`[data-document-id="${CSS.escape(nextId)}"]`)
          ?.focus({ preventScroll: true });
      });
    }
  }, [currentIndex, rows]);

  const openPreview = useCallback(() => {
    if (!current) return;
    setPreviewSequence((value) => value + 1);
    setPreviewDoc(current);
  }, [current]);

  const closePreview = useCallback(() => {
    setPreviewDoc(null);
  }, []);

  useEffect(() => {
    if (queue.isLoading || queue.isError) return undefined;
    const frame = requestAnimationFrame(() => workspaceRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [queue.isError, queue.isLoading]);

  const onWorkspaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (look && (event.key === ' ' || event.key === 'Escape')) {
      event.preventDefault();
      closePreview();
      return;
    }
    if (isEditableTarget(event.target)) {
      if (event.key === 'Escape') setPanel(null);
      return;
    }

    const key = event.key.toLowerCase();
    if (event.key === 'Escape') {
      setPanel(null);
      setNotice(null);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === 'a') {
      event.preventDefault();
      setSelected(new Set(rows.map((row) => row.id)));
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const rowHasFocus = event.target instanceof HTMLElement
      && Boolean(event.target.closest('tr[data-document-id]'));
    if (key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(1, rowHasFocus);
      return;
    }
    if (key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1, rowHasFocus);
      return;
    }
    if (event.key === ' ' && current) {
      event.preventDefault();
      openPreview();
      return;
    }
    if (event.shiftKey && key === 'a') {
      event.preventDefault();
      setNotice({
        tone: 'warning',
        text: 'Whole-file approval is unavailable: the server has no atomic, checklist-aware audit contract for it.',
      });
      return;
    }
    if ((key === 'a' || key === 'r') && current) {
      event.preventDefault();
      setPanel(key === 'a' ? 'approve' : 'reject');
    }
  };

  const selectedOnPage = useMemo(
    () => rows.filter((row) => selected.has(row.id)).length,
    [rows, selected],
  );
  const allOnPage = rows.length > 0 && selectedOnPage === rows.length;

  const choose = (doc: ReviewDoc) => {
    setActiveId(doc.id);
    setPanel(null);
    setNotice(null);
    requestAnimationFrame(() => workspaceRef.current?.focus({ preventScroll: true }));
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };


  if (queue.isLoading) return <div className="module-state">Loading the document queue…</div>;
  if (queue.isError) {
    return (
      <div className="module-state module-state-error">
        <strong>Document queue unavailable</strong>
        <span>{(queue.error as Error).message}</span>
        <button className="primary-button" onClick={() => queue.refetch()}>Try again</button>
      </div>
    );
  }

  return (
    <div
      className="triage-view"
      ref={workspaceRef}
      tabIndex={0}
      role="region"
      aria-label="Document triage keyboard workspace"
      onKeyDown={onWorkspaceKeyDown}
    >
      <p className="visually-hidden" aria-live="polite">
        {current ? `${pretty(current.docType)} for ${applicantName(current)}, row ${currentIndex + 1} of ${rows.length}` : 'No document selected'}
      </p>
      <header className="triage-toolbar" inert={look} aria-hidden={look || undefined}>
        <div>
          <p className="eyebrow">Oldest first · live 30s refresh · shortcuts scoped to this workspace</p>
          <h2>{(queue.data?.meta.total ?? 0).toLocaleString('en-GY')} documents waiting</h2>
        </div>
        <div className="shortcut-strip" aria-label="Keyboard shortcuts">
          <span><kbd>J</kbd><kbd>K</kbd> move</span>
          <span><kbd>A</kbd> review approval</span>
          <span><kbd>R</kbd> prepare rejection</span>
          <span><kbd>Space</kbd> full screen</span>
        </div>
      </header>

      <div className="triage-contract-gap" role="status" inert={look} aria-hidden={look || undefined}>
        <span aria-hidden="true">!</span>
        <p>
          <strong>Decision recording unavailable.</strong> The API transition and audit write are not atomic. You can inspect and prepare a decision here; Mission Control will not send a state change.
        </p>
      </div>

      {notice && (
        <div className={`triage-notice ${notice.tone}`} role="status" inert={look} aria-hidden={look || undefined}>
          <span aria-hidden="true">{notice.tone === 'success' ? '✓' : '!'}</span>
          <p>{notice.text}</p>
          <button className="quiet-button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {selectedOnPage > 0 && (
        <div className="bulk-bar" inert={look} aria-hidden={look || undefined}>
          <strong>{selectedOnPage} selected on this loaded page</strong>
          <span>Selection is local only. Bulk decisions require a server audit contract.</span>
          <button className="quiet-button" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="triage-workspace" inert={look} aria-hidden={look || undefined}>
        <section className="queue-pane" aria-label="Document queue">
          <div className="queue-table-wrap" ref={tableRef}>
            <table className="queue-table" role="grid" aria-label="Pending document queue">
              <thead>
                <tr>
                  <th className="select-column">
                    <PageCheckbox
                      checked={allOnPage}
                      indeterminate={selectedOnPage > 0 && !allOnPage}
                      onChange={(checked) => setSelected(checked ? new Set(rows.map((row) => row.id)) : new Set())}
                    />
                  </th>
                  <th>Applicant</th>
                  <th>Document</th>
                  <th>For</th>
                  <th>Waiting</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((doc) => {
                  const wait = waitingLabel(doc.createdAt);
                  const active = doc.id === activeId;
                  return (
                    <tr
                      key={doc.id}
                      data-document-id={doc.id}
                      className={active ? 'active' : ''}
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      onFocus={() => {
                        setActiveId(doc.id);
                        setPanel(null);
                        setNotice(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          choose(doc);
                        }
                      }}
                      onClick={() => choose(doc)}
                    >
                      <td className="select-column" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(doc.id)}
                          onChange={(event) => toggleSelected(doc.id, event.target.checked)}
                          aria-label={`Select ${pretty(doc.docType)} for ${applicantName(doc)}`}
                        />
                      </td>
                      <td>
                        <strong>{applicantName(doc)}</strong>
                        <small>{doc.user?.phone ?? 'Phone unavailable'} · {doc.user?.countryCode ?? 'Market unavailable'}</small>
                      </td>
                      <td><strong>{pretty(doc.docType)}</strong></td>
                      <td><span className="role-chip">{pretty(doc.role)}</span></td>
                      <td>
                        <span className={wait.breaching ? 'wait-chip breaching' : 'wait-chip'} title={wait.detail}>{wait.short}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && (
              <EmptyFeed>
                {(queue.data?.meta.total ?? 0) === 0
                  ? 'Queue clear. Nobody is waiting on a document decision.'
                  : 'This page no longer has pending rows. Returning to the last available page…'}
              </EmptyFeed>
            )}
          </div>
          <footer className="queue-footer">
            <span>
              Showing {rows.length.toLocaleString('en-GY')} of {(queue.data?.meta.total ?? 0).toLocaleString('en-GY')} · page {page} of {Math.max(1, queue.data?.meta.totalPages ?? 1)}
            </span>
            <div>
              <button className="quiet-button" disabled={page <= 1} onClick={() => { setPage((value) => value - 1); setSelected(new Set()); }}>Previous</button>
              <button className="quiet-button" disabled={page >= (queue.data?.meta.totalPages ?? 1)} onClick={() => { setPage((value) => value + 1); setSelected(new Set()); }}>Next</button>
            </div>
          </footer>
        </section>

        <section className="review-pane" aria-label="Human document decision">
          {current ? (
            <>
              <header className="review-heading">
                <div className="review-subject">
                  <span className="subject-initials" aria-hidden="true">
                    {(current.user?.firstName?.[0] ?? current.user?.phone?.[0] ?? '?').toUpperCase()}
                    {(current.user?.lastName?.[0] ?? '').toUpperCase()}
                  </span>
                  <div>
                    <p className="eyebrow">The document</p>
                    <h3>{pretty(current.docType)}</h3>
                    <span>{applicantName(current)} · {current.user?.phone ?? 'Phone unavailable'} · {pretty(current.role)}</span>
                  </div>
                </div>
                <button
                  className="quiet-button"
                  onClick={openPreview}
                >
                  Open full screen
                </button>
              </header>

              <div className="human-decision-rail">
                <span aria-hidden="true">Human</span>
                <p>No machine verdict is shown in this queue. Compare the evidence and form the document decision yourself.</p>
              </div>

              <ApplicantSourceRecord
                doc={current}
                record={applicantRecord.data}
                state={applicantRecordState}
                error={applicantRecord.error as Error | null}
              />

              <div
                className="document-preview-shell"
                onMouseDown={() => workspaceRef.current?.focus({ preventScroll: true })}
              >
                <DocumentFrame key={current.id} docId={current.id} />
                <button className="preview-open-button" onClick={openPreview}>Open full screen</button>
              </div>

              {panel === 'approve' && (
                <ApprovePanel
                  key={`approve-${current.id}`}
                  doc={current}
                  record={applicantRecord.data}
                  recordState={applicantRecordState}
                  onCancel={() => setPanel(null)}
                />
              )}
              {panel === 'reject' && (
                <RejectPanel
                  key={`reject-${current.id}`}
                  doc={current}
                  onCancel={() => setPanel(null)}
                />
              )}

              {!panel && (
                <div className="decision-dock">
                  <div className="whole-file-gap">
                    <kbd>⇧A</kbd>
                    <span>
                      <strong>Whole-file approval unavailable</strong>
                      <small>No safe atomic server contract exists.</small>
                    </span>
                  </div>
                  <button
                    className="reject-button secondary"
                    onClick={() => setPanel('reject')}
                  >
                    Prepare rejection <kbd>R</kbd>
                  </button>
                  <button
                    className="approve-button"
                    onClick={() => setPanel('approve')}
                  >
                    Review to approve <kbd>A</kbd>
                  </button>
                </div>
              )}
            </>
          ) : (
            <EmptyFeed>Select a document to begin review.</EmptyFeed>
          )}
        </section>
      </div>

      {previewDoc && (
        <FullScreenPreview doc={previewDoc} sequence={previewSequence} onClose={closePreview} />
      )}
    </div>
  );
}
