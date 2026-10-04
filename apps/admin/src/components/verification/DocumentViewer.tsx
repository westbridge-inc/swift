'use client';
import { useEffect, useRef, useState } from 'react';
import { API_URL, getDocSignedUrl } from '@/lib/api';
import { Modal } from '@/components/Modal';

export function DocumentViewer({ id, label, onViewed }: { id: string; label: string; onViewed: (_viewed: boolean) => void }) {
  const [url, setUrl] = useState('');
  const [pdf, setPdf] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [full, setFull] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const view = async () => {
    const attempt = ++generation.current;
    setLoading(true); setError(''); setUrl(''); setLoaded(false); onViewed(false);
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
      if (!response.ok) throw new Error(response.status === 410 ? 'This document was removed under the retention policy.' : `The document is unavailable (HTTP ${response.status}).`);
      // No Blob, storage, download or cached bytes. Rendering stays on the no-store proxy.
      const isPdf = response.headers.get('content-type')?.split(';')[0] === 'application/pdf';
      await response.body?.cancel();
      if (generation.current !== attempt) return;
      setPdf(isPdf); setUrl(proxy);
    } catch (err) {
      if (generation.current === attempt) setError(err instanceof Error ? err.message : 'The document could not be loaded.');
    } finally { if (generation.current === attempt) setLoading(false); }
  };
  const failed = () => { setError('The document did not render. Retry the view before approving.'); setLoaded(false); setUrl(''); onViewed(false); };
  const evidence = <div className="rc-evidence-viewport">
    {pdf ? <>
      <iframe title={`${label} evidence`} src={url} className="rc-pdf" sandbox="allow-same-origin" />
      <label className="rc-check"><input type="checkbox" checked={loaded} onChange={(e) => { setLoaded(e.target.checked); onViewed(e.target.checked); }} />PDF is visible and readable</label>
      <p className="rc-muted">If your browser cannot display this PDF, leave the check clear. Do not approve unreadable evidence.</p>
    </> :
      // next/image would persist optimized evidence. Direct no-store rendering is intentional.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={`${label} evidence`} onLoad={() => { setLoaded(true); onViewed(true); }} onError={failed}
        style={{ transform: `rotate(${rotation}deg) scale(${zoom})` }} className="rc-document-image" />}
  </div>;
  const controls = <div className="rc-viewer-tools" aria-label="Document view controls">
    <button type="button" disabled={pdf} onClick={() => setZoom((v) => Math.max(0.5, v - 0.25))} aria-label="Zoom out">−</button>
    <span>{Math.round(zoom * 100)}%</span>
    <button type="button" disabled={pdf} onClick={() => setZoom((v) => Math.min(3, v + 0.25))} aria-label="Zoom in">+</button>
    <button type="button" disabled={pdf} onClick={() => setRotation((v) => (v + 90) % 360)}>Rotate</button>
    <button type="button" onClick={() => { setZoom(1); setRotation(0); }}>Reset view</button>
    <button type="button" onClick={() => setFull(!full)}>{full ? 'Exit full screen' : 'Full screen'}</button>
  </div>;
  return <section className="rc-viewer" aria-label="Document evidence">
    <div className="rc-viewer-heading"><span>Document evidence</span><button type="button" disabled={loading} onClick={() => void view()}>{loading ? 'Loading document…' : loaded ? 'View document again' : 'View document'}</button></div>
    {error && <p role="alert" className="rc-error">Document could not be displayed. {error} Retry using View document.</p>}
    {!url && !error && <div className="rc-viewer-empty">Open the document before deciding — a decision without opening it is not a review.</div>}
    {url && !full && <>{controls}{evidence}</>}
    {full && <Modal title="Document full screen" onClose={() => setFull(false)} className="rc-fullscreen">{controls}{evidence}</Modal>}
  </section>;
}
