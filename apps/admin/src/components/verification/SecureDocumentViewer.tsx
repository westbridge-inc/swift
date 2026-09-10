'use client';

import { useEffect, useRef, useState } from 'react';
import { BROWSER_CLIENT } from '@/lib/api';

// Page boxes are attacker-controlled PDF metadata. Canvas allocation is immediate,
// so limits must be checked before a canvas is created.
export const MAX_REVIEW_PDF_PAGES = 50;
export const MAX_PDF_PAGE_DIMENSION = 14_400;
export const MAX_PDF_CANVAS_WIDTH = 2_048;
export const MAX_PDF_CANVAS_HEIGHT = 2_048;
export const MAX_PDF_PAGE_PIXELS = 4_194_304;
export const MAX_PDF_PAGE_BYTES = MAX_PDF_PAGE_PIXELS * 4;
// Pages are retained one at a time. This finite total bounds adversarial decode
// work across a document without allocating this amount of bitmap memory at once.
export const MAX_PDF_TOTAL_PIXELS = 134_217_728;
export const MAX_PDF_TOTAL_BYTES = MAX_PDF_TOTAL_PIXELS * 4;
// PDF page geometry does not constrain the source rasters embedded in a page.
// PDF.js otherwise accepts unlimited image pixels and can decode a tiny,
// highly-compressed file into an enormous worker allocation before rendering.
export const MAX_PDF_EMBEDDED_IMAGE_PIXELS = 16_777_216;
export const MAX_REVIEW_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_RASTER_DIMENSION = 8_192;
export const MAX_RASTER_PIXELS = 16_777_216;
// PDF.js is processing attacker-controlled input. Size and geometry bounds do
// not prevent pathological filters, fonts, operators, or a wedged worker from
// monopolising a reviewer tab, so both preparation and each visible page have
// a hard wall-clock budget.
export const PDF_PREPARE_TIMEOUT_MS = 20_000;
export const PDF_PAGE_RENDER_TIMEOUT_MS = 15_000;

const MIN_VIEWPORT_WIDTH = 320;
const MAX_RENDER_SCALE = 2;

interface SecureDocumentViewerProps {
  url: string;
  reviewGrantToken: string;
  mimeType: string;
  label: string;
  onRendered: () => void;
  onError: () => void;
}

interface PdfViewport {
  width: number;
  height: number;
}

interface PdfPage {
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (options: {
    canvas: HTMLCanvasElement;
    viewport: PdfViewport;
    annotationMode: number;
    transform?: number[];
  }) => { promise: Promise<void>; cancel?: () => void };
  cleanup?: () => void;
}

interface PdfDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  cleanup?: () => void;
  destroy?: () => Promise<void>;
}

interface LoadingTask {
  promise: Promise<PdfDocument>;
  destroy: () => Promise<void>;
}

interface PagePlan {
  viewport: PdfViewport;
  canvasWidth: number;
  canvasHeight: number;
  pixels: number;
  bytes: number;
}

class UnsafePdfError extends Error {}
class UnsafeRasterError extends Error {}
class PdfOperationCancelledError extends Error {}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  message: string,
): { promise: Promise<T>; cancel: () => void } {
  let cancel = () => undefined;
  const guarded = new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } finally {
        reject(new UnsafePdfError(message));
      }
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      },
    );
    cancel = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new PdfOperationCancelledError('PDF operation cancelled.'));
    };
  });
  return { promise: guarded, cancel };
}

interface RasterDimensions {
  width: number;
  height: number;
  animated: boolean;
}

function uint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function pngDimensions(bytes: Uint8Array): RasterDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) return null;
  const dimensions = { width: view.getUint32(16), height: view.getUint32(20), animated: false };
  let offset = 8;
  let sawIhdr = false;
  while (offset + 12 <= bytes.length) {
    const chunkLength = view.getUint32(offset);
    if (chunkLength > bytes.length - offset - 12) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!sawIhdr && (type !== 'IHDR' || chunkLength !== 13)) return null;
    sawIhdr = true;
    if (type === 'acTL') dimensions.animated = true;
    offset += 12 + chunkLength;
    if (type === 'IEND') return dimensions;
  }
  return null;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        animated: false,
      };
    }
    offset += segmentLength;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (
    bytes.length < 20
    || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP'
  ) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let dimensions: RasterDimensions | null = null;
  let animated = false;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (size > bytes.length || data + size > bytes.length) return null;
    if (type === 'VP8X' && size >= 10) {
      animated ||= (bytes[data]! & 0x02) !== 0;
      dimensions = { width: uint24Le(bytes, data + 4) + 1, height: uint24Le(bytes, data + 7) + 1, animated };
    }
    if (type === 'VP8 ' && size >= 10
      && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      dimensions = {
        width: view.getUint16(data + 6, true) & 0x3fff,
        height: view.getUint16(data + 8, true) & 0x3fff,
        animated,
      };
    }
    if (type === 'VP8L' && size >= 5 && bytes[data] === 0x2f) {
      const bits = view.getUint32(data + 1, true);
      dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated };
    }
    if (type === 'ANIM' || type === 'ANMF') animated = true;
    offset = data + size + (size % 2);
  }
  return dimensions ? { ...dimensions, animated: dimensions.animated || animated } : null;
}

function assertSafeRaster(bytes: ArrayBuffer, mimeType: string): void {
  const source = new Uint8Array(bytes);
  const dimensions = mimeType === 'image/png'
    ? pngDimensions(source)
    : mimeType === 'image/jpeg' || mimeType === 'image/jpg'
      ? jpegDimensions(source)
      : mimeType === 'image/webp'
        ? webpDimensions(source)
        : null;
  if (!dimensions) throw new UnsafeRasterError('Image metadata could not be validated safely.');
  if (dimensions.animated) {
    throw new UnsafeRasterError('Animated images are not permitted for secure document review.');
  }
  const pixels = dimensions.width * dimensions.height;
  if (
    !Number.isSafeInteger(dimensions.width)
    || !Number.isSafeInteger(dimensions.height)
    || dimensions.width < 1
    || dimensions.height < 1
    || dimensions.width > MAX_RASTER_DIMENSION
    || dimensions.height > MAX_RASTER_DIMENSION
    || !Number.isSafeInteger(pixels)
    || pixels > MAX_RASTER_PIXELS
  ) {
    throw new UnsafeRasterError('Image dimensions exceed the secure review limit.');
  }
}

function pagePlan(page: PdfPage, availableWidth: number, pixelRatio: number): PagePlan {
  const base = page.getViewport({ scale: 1 });
  if (
    !Number.isFinite(base.width) ||
    !Number.isFinite(base.height) ||
    base.width <= 0 ||
    base.height <= 0 ||
    base.width > MAX_PDF_PAGE_DIMENSION ||
    base.height > MAX_PDF_PAGE_DIMENSION
  ) {
    throw new UnsafePdfError('PDF page geometry is outside the secure review limit.');
  }

  const safePixelRatio = Math.min(2, Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1));
  const maxCssWidth = MAX_PDF_CANVAS_WIDTH / safePixelRatio;
  const maxCssHeight = MAX_PDF_CANVAS_HEIGHT / safePixelRatio;
  const scale = Math.min(
    MAX_RENDER_SCALE,
    Math.max(MIN_VIEWPORT_WIDTH, availableWidth) / base.width,
    maxCssWidth / base.width,
    maxCssHeight / base.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new UnsafePdfError('PDF page scale is outside the secure review limit.');
  }

  const viewport = page.getViewport({ scale });
  const canvasWidth = Math.ceil(viewport.width * safePixelRatio);
  const canvasHeight = Math.ceil(viewport.height * safePixelRatio);
  const pixels = canvasWidth * canvasHeight;
  const bytes = pixels * 4;
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    !Number.isSafeInteger(canvasWidth) ||
    !Number.isSafeInteger(canvasHeight) ||
    canvasWidth < 1 ||
    canvasHeight < 1 ||
    canvasWidth > MAX_PDF_CANVAS_WIDTH ||
    canvasHeight > MAX_PDF_CANVAS_HEIGHT ||
    !Number.isSafeInteger(pixels) ||
    pixels > MAX_PDF_PAGE_PIXELS ||
    bytes > MAX_PDF_PAGE_BYTES
  ) {
    throw new UnsafePdfError('PDF page rasterisation exceeds the secure review limit.');
  }
  return { viewport, canvasWidth, canvasHeight, pixels, bytes };
}

/**
 * PDF.js renders only pixels: no annotations, JavaScript, forms, or links. PDF
 * geometry is validated before canvas creation and only the selected page stays
 * resident. Images are fetched with the session and decoded from a Blob URL.
 */
export function SecureDocumentViewer({
  url,
  reviewGrantToken,
  mimeType,
  label,
  onRendered,
  onError,
}: SecureDocumentViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PdfDocument | null>(null);
  const terminatePdfRef = useRef<(() => void) | null>(null);
  // React StrictMode deliberately replays effects. Keep the one-use byte read
  // on the component instance so the replay attaches to the same promise
  // instead of spending the bearer grant twice.
  const byteFlightRef = useRef<{ identity: string; promise: Promise<ArrayBuffer> } | null>(null);
  const renderedRef = useRef(false);
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const onRenderedRef = useRef(onRendered);
  const onErrorRef = useRef(onError);
  const [pdfState, setPdfState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [pdfError, setPdfError] = useState('');
  const [plans, setPlans] = useState<PagePlan[] | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [renderedPageCount, setRenderedPageCount] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  onRenderedRef.current = onRendered;
  onErrorRef.current = onError;

  useEffect(() => {
    renderedRef.current = false;
    renderedPagesRef.current = new Set();
    setPdfState('loading');
    setPdfError('');
    setPlans(null);
    setPageNumber(1);
    setRenderedPageCount(0);
    setImageUrl(null);

    let cancelled = false;
    let preparationAborted = false;
    let objectUrl: string | null = null;
    const fail = (error: unknown) => {
      if (cancelled) return;
      setPdfState('failed');
      setPdfError(error instanceof UnsafePdfError || error instanceof UnsafeRasterError
        ? error.message
        : 'The document could not be rendered safely.');
      onErrorRef.current();
    };
    const requestIdentity = `${url}\u0000${reviewGrantToken}`;
    if (byteFlightRef.current?.identity !== requestIdentity) {
      byteFlightRef.current = {
        identity: requestIdentity,
        promise: fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          headers: {
            'X-Swift-Client': BROWSER_CLIENT,
            'X-Swift-Review-Grant': reviewGrantToken,
          },
        }).then(async (response) => {
          if (!response.ok) throw new Error(`Document request failed (${response.status}).`);
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength < 1 || bytes.byteLength > MAX_REVIEW_SOURCE_BYTES) {
            throw new UnsafePdfError('Document bytes are outside the secure review limit.');
          }
          return bytes;
        }),
      };
    }
    const byteFlight = byteFlightRef.current.promise;

    if (mimeType !== 'application/pdf') {
      void (async () => {
        try {
          const bytes = await byteFlight;
          if (cancelled) return;
          assertSafeRaster(bytes, mimeType);
          const blob = new Blob([bytes], { type: mimeType });
          objectUrl = URL.createObjectURL(blob);
          setImageUrl(objectUrl);
        } catch (error) {
          fail(error);
        }
      })();
      return () => {
        cancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }

    const container = containerRef.current;
    if (!container) return () => { cancelled = true; };
    container.replaceChildren();
    let loadingTask: LoadingTask | null = null;
    let loadingTaskDestroyStarted = false;
    let cancelPrepareDeadline: (() => void) | null = null;
    const terminateLoadingTask = () => {
      if (!loadingTask || loadingTaskDestroyStarted) return;
      loadingTaskDestroyStarted = true;
      void loadingTask.destroy().catch(() => undefined);
    };
    terminatePdfRef.current = terminateLoadingTask;
    void (async () => {
      try {
        const [pdfjs, bytes] = await Promise.all([import('pdfjs-dist'), byteFlight]);
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        const task = pdfjs.getDocument({
          data: new Uint8Array(bytes),
          disableRange: true,
          disableStream: true,
          enableXfa: false,
          isEvalSupported: false,
          stopAtErrors: true,
          maxImageSize: MAX_PDF_EMBEDDED_IMAGE_PIXELS,
          canvasMaxAreaInBytes: MAX_PDF_PAGE_BYTES,
        }) as unknown as LoadingTask;
        loadingTask = task;
        const prepareDeadline = withDeadline((async () => {
          const pdf = await task.promise;
          if (cancelled || preparationAborted) {
            throw new UnsafePdfError('PDF preparation was cancelled.');
          }
          if (pdf.numPages < 1 || pdf.numPages > MAX_REVIEW_PDF_PAGES) {
            throw new UnsafePdfError(`PDF has ${pdf.numPages} pages; the review limit is ${MAX_REVIEW_PDF_PAGES}.`);
          }

          const availableWidth = Math.min(
            MAX_PDF_CANVAS_WIDTH,
            Math.max(MIN_VIEWPORT_WIDTH, container.clientWidth || MIN_VIEWPORT_WIDTH),
          );
          const devicePixelRatio = window.devicePixelRatio || 1;
          const nextPlans: PagePlan[] = [];
          let totalPixels = 0;
          let totalBytes = 0;
          for (let currentPage = 1; currentPage <= pdf.numPages; currentPage += 1) {
            if (cancelled || preparationAborted) throw new UnsafePdfError('PDF preparation was cancelled.');
            const page = await pdf.getPage(currentPage);
            try {
              if (cancelled || preparationAborted) throw new UnsafePdfError('PDF preparation was cancelled.');
              const plan = pagePlan(page, availableWidth, devicePixelRatio);
              totalPixels += plan.pixels;
              totalBytes += plan.bytes;
              if (
                !Number.isSafeInteger(totalPixels) ||
                !Number.isSafeInteger(totalBytes) ||
                totalPixels > MAX_PDF_TOTAL_PIXELS ||
                totalBytes > MAX_PDF_TOTAL_BYTES
              ) {
                throw new UnsafePdfError('PDF cumulative rasterisation exceeds the secure review limit.');
              }
              nextPlans.push(plan);
            } finally {
              page.cleanup?.();
            }
          }
          return { pdf, nextPlans };
        })(), PDF_PREPARE_TIMEOUT_MS, () => {
          preparationAborted = true;
          terminateLoadingTask();
        },
        'PDF preparation exceeded the secure review time limit.');
        cancelPrepareDeadline = prepareDeadline.cancel;
        const prepared = await prepareDeadline.promise;
        cancelPrepareDeadline = null;
        if (cancelled || preparationAborted) return;
        pdfRef.current = prepared.pdf;
        setPlans(prepared.nextPlans);
      } catch (error) {
        // A parser/decoder rejection must also terminate its worker and release
        // any partial image allocations; waiting for unmount leaves an attacker
        // controlled task alive while the failed viewer remains on screen.
        preparationAborted = true;
        terminateLoadingTask();
        fail(error);
      }
    })();

    return () => {
      cancelled = true;
      preparationAborted = true;
      cancelPrepareDeadline?.();
      cancelPrepareDeadline = null;
      container.replaceChildren();
      pdfRef.current = null;
      terminateLoadingTask();
      if (terminatePdfRef.current === terminateLoadingTask) terminatePdfRef.current = null;
    };
  }, [mimeType, reviewGrantToken, url]);

  useEffect(() => {
    if (mimeType !== 'application/pdf' || !plans) return;
    const container = containerRef.current;
    const pdf = pdfRef.current;
    const plan = plans[pageNumber - 1];
    if (!container || !pdf || !plan) return;
    let cancelled = false;
    let renderAborted = false;
    let renderCancelStarted = false;
    let cancelRenderDeadline: (() => void) | null = null;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    // Own the worker that produced this exact PdfDocument. A stale effect must
    // never dereference the mutable ref after a URL/token change and terminate
    // the replacement document's task.
    const terminateOwnedPdf = terminatePdfRef.current;
    const pageRef: { current: PdfPage | null } = { current: null };
    const cancelRender = () => {
      if (renderCancelStarted) return;
      renderCancelStarted = true;
      renderTask?.cancel?.();
    };
    const cleanupPage = () => {
      const current = pageRef.current;
      pageRef.current = null;
      current?.cleanup?.();
    };
    container.replaceChildren();
    setPdfState('loading');

    void (async () => {
      try {
        const renderDeadline = withDeadline((async () => {
          const pdfjs = await import('pdfjs-dist');
          if (cancelled || renderAborted) return;
          pageRef.current = await pdf.getPage(pageNumber);
          if (cancelled || renderAborted) {
            cleanupPage();
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.setAttribute('aria-label', `${label}, page ${pageNumber} of ${plans.length}`);
          canvas.className = 'block mx-auto max-w-full bg-white shadow';
          canvas.width = plan.canvasWidth;
          canvas.height = plan.canvasHeight;
          canvas.style.width = `${Math.ceil(plan.viewport.width)}px`;
          canvas.style.height = `${Math.ceil(plan.viewport.height)}px`;
          container.appendChild(canvas);
          const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
          renderTask = pageRef.current.render({
            canvas,
            viewport: plan.viewport,
            annotationMode: pdfjs.AnnotationMode.DISABLE,
            transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
          });
          await renderTask.promise;
          if (cancelled || renderAborted) return;
        })(), PDF_PAGE_RENDER_TIMEOUT_MS, () => {
          renderAborted = true;
          cancelRender();
          cleanupPage();
          terminateOwnedPdf?.();
        }, 'PDF page rendering exceeded the secure review time limit.');
        cancelRenderDeadline = renderDeadline.cancel;
        await renderDeadline.promise;
        cancelRenderDeadline = null;
        cleanupPage();
        if (cancelled || renderAborted) return;
        setPdfState('ready');
        renderedPagesRef.current.add(pageNumber);
        setRenderedPageCount(renderedPagesRef.current.size);
        if (!renderedRef.current && renderedPagesRef.current.size === plans.length) {
          renderedRef.current = true;
          onRenderedRef.current();
        }
      } catch (error) {
        if (cancelled || error instanceof PdfOperationCancelledError) {
          cleanupPage();
          return;
        }
        renderAborted = true;
        cancelRender();
        cleanupPage();
        container.replaceChildren();
        if ((error as { name?: string })?.name !== 'RenderingCancelledException') {
          // A rejected or timed-out render is terminal for this PDF instance.
          // Tear down the worker immediately instead of leaving hostile parser
          // state resident until the reviewer navigates away.
          pdfRef.current = null;
          terminateOwnedPdf?.();
          setPdfState('failed');
          setPdfError(error instanceof UnsafePdfError ? error.message : 'The document could not be rendered safely.');
          onErrorRef.current();
        }
      }
    })();

    return () => {
      cancelled = true;
      renderAborted = true;
      cancelRenderDeadline?.();
      cancelRenderDeadline = null;
      cancelRender();
      cleanupPage();
      container.replaceChildren();
    };
  }, [label, mimeType, pageNumber, plans]);

  const imageLoaded = () => {
    if (renderedRef.current) return;
    renderedRef.current = true;
    setPdfState('ready');
    onRenderedRef.current();
  };

  const imageFailed = () => {
    if (renderedRef.current) return;
    setPdfState('failed');
    setPdfError('The document could not be rendered safely.');
    onErrorRef.current();
  };

  const isPdf = mimeType === 'application/pdf';
  return (
    <div className="rounded-lg border border-[var(--border)] bg-neutral-800 p-2">
      {pdfState === 'loading' && <p role="status" className="p-3 text-sm text-[var(--muted)]">Rendering document securely…</p>}
      {pdfState === 'failed' && <p role="alert" className="p-3 text-sm text-red-400">Document viewer failed: {pdfError}</p>}
      {isPdf ? (
        <>
          <div ref={containerRef} className="max-h-[70vh] overflow-auto" aria-label={label} />
          {plans && pdfState !== 'failed' && (
            <div className="mt-2 flex items-center justify-between gap-2 text-sm">
              <button
                type="button"
                onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
                disabled={pageNumber === 1 || pdfState === 'loading'}
                className="rounded border border-[var(--border)] px-2 py-1 disabled:opacity-40"
              >
                Previous page
              </button>
              <span>Page {pageNumber} of {plans.length} · reviewed {renderedPageCount} of {plans.length}</span>
              <button
                type="button"
                onClick={() => setPageNumber((current) => Math.min(plans.length, current + 1))}
                disabled={pageNumber === plans.length || pdfState === 'loading'}
                className="rounded border border-[var(--border)] px-2 py-1 disabled:opacity-40"
              >
                Next page
              </button>
            </div>
          )}
        </>
      ) : imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a Blob URL is decoded only after an authenticated fetch.
        <img
          src={imageUrl}
          alt={label}
          onLoad={imageLoaded}
          onError={imageFailed}
          className="w-full max-h-[70vh] object-contain rounded-lg border border-[var(--border)] bg-black"
        />
      ) : null}
    </div>
  );
}
