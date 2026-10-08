'use client';
import { useEffect, useRef, useState } from 'react';
import { API_URL, getDocSignedUrl } from '@/lib/api';
import { Modal } from '@/components/Modal';

export function DocumentViewer({ id, label, onViewed, onRejectMissing }: { id: string; label: string; onViewed: (_viewed: boolean) => void; onRejectMissing?: () => void }) {
  const [url, setUrl] = useState('');
  const [pdf, setPdf] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState(false);
  const [pdfFailed, setPdfFailed] = useState(false);
  const [pdfInlineLoaded, setPdfInlineLoaded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [full, setFull] = useState(false);
  const generation = useRef(0);
  const evidenceViewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!url || !window.matchMedia('(max-width: 767px)').matches) return;
    const evidence = evidenceViewport.current;
    const pane = evidence?.closest<HTMLElement>('.rc-workspace');
    if (evidence && pane) pane.scrollTop += evidence.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }, [url]);
  useEffect(() => () => { generation.current++; }, []);
  const view = async () => {
    const attempt = ++generation.current;
    setLoading(true); setError(''); setMissing(false); setPdfFailed(false); setPdfInlineLoaded(false); setUrl(''); setLoaded(false); onViewed(false);
    setZoom(1); setRotation(0);
    try {
      const signed = await getDocSignedUrl(id);
      const render = new URL(signed.data?.url ?? '', API_URL);
      // Only the audited route for THIS document. Never fileUrl or an arbitrary returned path.
      if (!signed.data?.url || render.pathname !== `/api/v1/verification/render/${encodeURIComponent(id)}` || !render.searchParams.has('sig') || !render.searchParams.has('expires')) {
        throw new Error('The document link is not a valid review link.');
      }
      const proxy = new URL(render.pathname + render.search, window.location.origin).toString();
      const response = await fetch(proxy, { cache: 'no-store', redirect: 'error' });
      if (!response.ok) {
        const unavailable = response.status === 404 || response.status === 410;
        throw Object.assign(new Error('The document could not be loaded.'), { code: response.status === 410 ? 'DOCUMENT_PURGED' : unavailable ? 'VERIFICATION_OBJECT_UNAVAILABLE' : 'RENDER_FAILED' });
      }
      // No Blob, storage, download or cached bytes. Rendering stays on the no-store proxy.
      const isPdf = response.headers.get('content-type')?.split(';')[0] === 'application/pdf';
      await response.body?.cancel();
      if (generation.current !== attempt) return;
      setPdf(isPdf); setUrl(proxy);
    } catch (err) {
      if (generation.current === attempt) {
        const code = (err as { code?: string })?.code;
        const unavailable = code === 'VERIFICATION_OBJECT_UNAVAILABLE' || code === 'DOCUMENT_PURGED';
        setMissing(unavailable);
        setError(unavailable ? (code === 'DOCUMENT_PURGED' ? 'This document was removed under the retention policy. The applicant must re-submit it before it can be approved.' : 'The file is missing. The applicant must re-submit it before it can be approved.') : 'The document could not be loaded. Try View document again.');
      }
    } finally { if (generation.current === attempt) setLoading(false); }
  };
  const evidenceGeneration = generation.current;
  const failed = () => { if (generation.current !== evidenceGeneration) return; setError('The document did not render. Retry the view before approving.'); setLoaded(false); setUrl(''); onViewed(false); };
  const evidence = <div ref={evidenceViewport} className="rc-evidence-viewport">
    {pdf ? <>
      <div className="rc-pdf-fallback">
        <p>{pdfFailed ? 'The inline PDF could not be displayed.' : 'If the PDF preview is blank or unreadable, open the document in a new tab.'}</p>
        <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open document in a new tab</a>
      </div>
      {!pdfFailed && <iframe title={`${label} evidence`} src={url} className="rc-pdf" sandbox="allow-same-origin" ref={(frame) => { if (frame) { frame.onload = () => { if (generation.current === evidenceGeneration) setPdfInlineLoaded(true); }; frame.onerror = () => { if (generation.current !== evidenceGeneration) return; setPdfFailed(true); setPdfInlineLoaded(false); setLoaded(false); onViewed(false); }; } }} />}
      <label className="rc-check"><input type="checkbox" disabled={!pdfInlineLoaded || pdfFailed} checked={loaded} onChange={(e) => { const confirmed = e.target.checked && pdfInlineLoaded && !pdfFailed; setLoaded(confirmed); onViewed(confirmed); }} />I can see and read the PDF in the inline preview</label>
      <p className="rc-muted">Approval requires a readable inline preview. Opening a new tab does not unlock approval.</p>
    </> :
      // next/image would persist optimized evidence. Direct no-store rendering is intentional.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={`${label} evidence`} onLoad={() => { if (generation.current !== evidenceGeneration) return; setLoaded(true); onViewed(true); }} onError={failed}
        style={{ width: `${zoom * 100}%`, transform: `rotate(${rotation}deg)` }} className="rc-document-image" />}
  </div>;
  const controls = <div className="rc-viewer-tools" aria-label="Document view controls">
    <button type="button" disabled={pdf} onClick={() => setZoom((v) => Math.max(0.5, v - 0.25))} aria-label="Zoom out">−</button>
    <span>{Math.round(zoom * 100)}%{zoom === 1 && !pdf ? " · Fit width" : ""}</span>
    <button type="button" disabled={pdf} onClick={() => setZoom((v) => Math.min(3, v + 0.25))} aria-label="Zoom in">+</button>
    <button type="button" disabled={pdf} onClick={() => setRotation((v) => (v + 90) % 360)}>Rotate</button>
    <button type="button" onClick={() => { setZoom(1); setRotation(0); }}>Reset view</button>
    <button type="button" onClick={() => setFull(!full)}>{full ? 'Exit full screen' : 'Full screen'}</button>
  </div>;
  return <section className="rc-viewer" aria-label="Document evidence">
    <div className="rc-viewer-heading"><span>Document evidence</span><button type="button" disabled={loading} onClick={() => void view()}>{loading ? 'Loading document…' : loaded ? 'View document again' : 'View document'}</button></div>
    {error && <p role="alert" className="rc-error">Document could not be displayed. {error}{missing && onRejectMissing && <> <button type="button" onClick={onRejectMissing}>Reject missing file</button></>}</p>}
    {!url && !error && <div className="rc-viewer-empty">Open the document before deciding — a decision without opening it is not a review.</div>}
    {url && !full && <>{controls}{evidence}</>}
    {full && <Modal title="Document full screen" onClose={() => setFull(false)} className="rc-fullscreen">{controls}{evidence}</Modal>}
  </section>;
}
