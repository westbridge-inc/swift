'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { documentLabel, getDocumentChecklist, type ChecklistRole, type VerificationStatus } from '@/lib/verification';

/** The same authenticated, country-specific checklist used by the phone.
 * Signup mounts this only after registration has established a session. */
export function DocumentChecklist({ role, vehicleType, uploadHref }: { role: ChecklistRole; vehicleType?: string; uploadHref?: string }) {
  const scope = `${role}:${vehicleType ?? 'saved'}`;
  const [result, setResult] = useState<{ scope: string; data?: VerificationStatus; failed?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    getDocumentChecklist(role, vehicleType).then(
      (data) => { if (active) setResult({ scope, data }); },
      () => { if (active) setResult({ scope, failed: true }); },
    );
    return () => { active = false; };
  }, [role, vehicleType, scope, retry]);
  const current = result?.scope === scope ? result : null;
  const data = current?.data;
  return <section aria-label="Required documents" className="space-y-3 rounded-2xl border border-black/5 bg-white p-5">
    <h2 className="font-bold">Required documents</h2>
    {!current ? <p role="status">Checking your required documents…</p>
      : current.failed ? <div role="alert"><p>Could not load your required documents. Please try again.</p><button type="button" className="min-h-11 text-[var(--swift-red)] underline" onClick={() => setRetry((n) => n + 1)}>Try documents again</button></div>
      : !data?.checklist.length ? <p role="status">{data?.categoryUnavailable
        ? 'Service checks pending. Choose your trade in the Swift phone app. You cannot receive requests until its required checks are ready.'
        : 'We cannot confirm your requirements right now. Please try again later.'}</p>
      : <ul className="space-y-2">{data.checklist.map((type) => <li key={type} className="flex flex-wrap justify-between gap-2"><span>{documentLabel(type)}</span><span className="text-sm text-[var(--swift-muted)]">{data.missing.includes(type) ? 'Required' : 'Approved'}</span></li>)}</ul>}
    {uploadHref ? <Link className="inline-block min-h-11 py-2 text-[var(--swift-red)] underline" href={uploadHref}>Upload your documents</Link>
      : <p className="text-sm text-[var(--swift-muted)]">Upload these in the Swift phone app: open your partner account, then Documents or the verification steps shown during setup.</p>}
  </section>;
}

/** Requirements for a standalone tradesperson are distinct from a services
 * business and depend on the trade saved in their phone account. */
export function ServiceProviderDocuments() {
  const [open, setOpen] = useState(false);
  return <div className="space-y-3">
    <button type="button" className="min-h-11 text-[var(--swift-red)] underline" aria-expanded={open} onClick={() => setOpen(!open)}>Service provider documents</button>
    {open ? <DocumentChecklist role="SERVICE_PROVIDER" /> : null}
  </div>;
}
