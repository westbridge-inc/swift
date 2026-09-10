import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_CLIENT } from '@/lib/api';
import {
  MAX_PDF_EMBEDDED_IMAGE_PIXELS,
  MAX_PDF_PAGE_BYTES,
  MAX_PDF_PAGE_DIMENSION,
  MAX_PDF_TOTAL_PIXELS,
  MAX_RASTER_DIMENSION,
  PDF_PAGE_RENDER_TIMEOUT_MS,
  PDF_PREPARE_TIMEOUT_MS,
  SecureDocumentViewer,
} from './SecureDocumentViewer';

const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {} as { workerSrc?: string },
  AnnotationMode: { DISABLE: 0 },
}));

vi.mock('pdfjs-dist', () => pdfjs);

type Deferred<T> = { promise: Promise<T>; resolve: (_value: T) => void; reject: (_reason?: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (_value: T) => void;
  let reject!: (_reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function jpegBytes(width = 32, height = 32): ArrayBuffer {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x07, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
  ]).buffer;
}

function pngBytes(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  // The decoder validates CRCs; the preflight parser needs only safe chunk
  // boundaries and a terminal IEND before it can reject hostile dimensions.
  bytes.set([0x49, 0x45, 0x4e, 0x44], 37);
  return bytes.buffer;
}

function apngBytes(width = 32, height = 32): ArrayBuffer {
  const base = new Uint8Array(pngBytes(width, height));
  const bytes = new Uint8Array(base.length + 20);
  bytes.set(base.subarray(0, 33));
  const view = new DataView(bytes.buffer);
  view.setUint32(33, 8);
  bytes.set([0x61, 0x63, 0x54, 0x4c], 37); // acTL
  view.setUint32(41, 2); // frame count
  view.setUint32(45, 0); // play forever
  bytes.set(base.subarray(33), 53);
  return bytes.buffer;
}

function webpBytes(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  view.setUint32(16, 10, true);
  const write24 = (offset: number, value: number) => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
  };
  write24(24, width - 1);
  write24(27, height - 1);
  return bytes.buffer;
}

function animatedWebpBytes(width = 32, height = 32): ArrayBuffer {
  const bytes = new Uint8Array(webpBytes(width, height));
  bytes[20] = bytes[20]! | 0x02; // VP8X animation feature bit
  return bytes.buffer;
}

function page(width = 612, height = 792) {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale })),
    render,
    cleanup: vi.fn(),
  };
}

function documentWithPages(pages: ReturnType<typeof page>[]) {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (number: number) => pages[number - 1]!),
    cleanup: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
}

function loadingTask(pdf: ReturnType<typeof documentWithPages>) {
  return { promise: Promise.resolve(pdf), destroy: vi.fn(async () => undefined) };
}

function viewer(props: Partial<React.ComponentProps<typeof SecureDocumentViewer>> = {}) {
  const onRendered = vi.fn();
  const onError = vi.fn();
  const result = render(
    <SecureDocumentViewer
      url="https://admin-api.test/api/v1/verification/render/test"
      reviewGrantToken="review-grant-token-for-viewer-tests-0001"
      mimeType="application/pdf"
      label="National ID"
      onRendered={onRendered}
      onError={onError}
      {...props}
    />,
  );
  return { ...result, onRendered, onError };
}

describe('SecureDocumentViewer hostile-document limits', () => {
  beforeEach(() => {
    pdfjs.getDocument.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
    })));
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 320 });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects non-finite and extreme page geometry before canvas allocation', async () => {
    const hostile = page(Infinity, 792);
    pdfjs.getDocument.mockReturnValue(loadingTask(documentWithPages([hostile])));
    const { onError, onRendered } = viewer();

    expect((await screen.findByRole('alert')).textContent).toContain('PDF page geometry is outside the secure review limit.');
    expect(hostile.render).not.toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBeNull();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();

    const extreme = page(MAX_PDF_PAGE_DIMENSION + 1, 792);
    pdfjs.getDocument.mockReturnValueOnce(loadingTask(documentWithPages([extreme])));
    const second = viewer({ url: 'https://admin-api.test/api/v1/verification/render/extreme' });
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(extreme.render).not.toHaveBeenCalled();
    second.unmount();
  });

  it('rejects a cumulative raster budget even though each individual page is permitted', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1_000 });
    const pages = Array.from({ length: 50 }, () => page(2_048, 2_048));
    pdfjs.getDocument.mockReturnValue(loadingTask(documentWithPages(pages)));
    const { onError } = viewer();

    expect((await screen.findByRole('alert')).textContent).toContain('PDF cumulative rasterisation exceeds the secure review limit.');
    expect(MAX_PDF_TOTAL_PIXELS).toBeLessThan(50 * 4_000_000);
    expect(pages.every((candidate) => candidate.render.mock.calls.length === 0)).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('fails closed for malformed PDFs and does not surface parser text', async () => {
    const task = { promise: Promise.reject(new Error('attacker supplied parser detail')), destroy: vi.fn(async () => undefined) };
    pdfjs.getDocument.mockReturnValue(task);
    const { onError } = viewer();

    expect((await screen.findByRole('alert')).textContent).toContain('The document could not be rendered safely.');
    expect(screen.queryByText(/attacker supplied/i)).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('caps embedded PDF image decoding and destroys the rejected worker without ACK', async () => {
    const task = {
      promise: Promise.reject(new Error('Image exceeded maxImageSize')),
      destroy: vi.fn(async () => undefined),
    };
    pdfjs.getDocument.mockReturnValue(task);
    const { onError, onRendered } = viewer();

    expect((await screen.findByRole('alert')).textContent).toContain('The document could not be rendered safely.');
    expect(pdfjs.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      maxImageSize: MAX_PDF_EMBEDDED_IMAGE_PIXELS,
      canvasMaxAreaInBytes: MAX_PDF_PAGE_BYTES,
      stopAtErrors: true,
    }));
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(document.querySelector('canvas')).toBeNull();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('cancels and destroys an in-flight PDF load without rendering or notifying after unmount', async () => {
    const pending = deferred<ReturnType<typeof documentWithPages>>();
    const task = { promise: pending.promise, destroy: vi.fn(async () => undefined) };
    pdfjs.getDocument.mockReturnValue(task);
    const { onError, onRendered, unmount } = viewer();

    await waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledOnce());
    unmount();
    pending.resolve(documentWithPages([page()]));
    await Promise.resolve();

    expect(task.destroy).toHaveBeenCalledOnce();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('uses the loading task as the sole document owner on unmount', async () => {
    const pdf = documentWithPages([page()]);
    pdf.cleanup.mockRejectedValue(new Error('cleanup must not be started during worker destruction'));
    const task = loadingTask(pdf);
    pdfjs.getDocument.mockReturnValue(task);
    const { onRendered, unmount } = viewer();

    await waitFor(() => expect(onRendered).toHaveBeenCalledOnce());
    unmount();
    await Promise.resolve();

    expect(pdf.cleanup).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it('times out and destroys a PDF worker whose preparation never settles', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof documentWithPages>>();
    const task = { promise: pending.promise, destroy: vi.fn(() => new Promise<void>(() => undefined)) };
    pdfjs.getDocument.mockReturnValue(task);
    const { onError, onRendered } = viewer();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(pdfjs.getDocument).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(PDF_PREPARE_TIMEOUT_MS); });

    expect(screen.getByRole('alert').textContent).toContain('PDF preparation exceeded the secure review time limit.');
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not resume PDF preparation when a timed-out load resolves late', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof documentWithPages>>();
    const pdf = documentWithPages([page()]);
    const task = { promise: pending.promise, destroy: vi.fn(async () => undefined) };
    pdfjs.getDocument.mockReturnValue(task);
    const { onError, onRendered } = viewer();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(PDF_PREPARE_TIMEOUT_MS); });
    pending.resolve(pdf);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(pdf.getPage).not.toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBeNull();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('times out a wedged page render, cancels it, and destroys the PDF worker without ACK', async () => {
    vi.useFakeTimers();
    const pendingRender = deferred<void>();
    const cancel = vi.fn();
    const hostilePage = page();
    hostilePage.render.mockReturnValue({ promise: pendingRender.promise, cancel });
    const pdf = documentWithPages([hostilePage]);
    const task = loadingTask(pdf);
    pdfjs.getDocument.mockReturnValue(task);
    const { onError, onRendered } = viewer();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hostilePage.render).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(PDF_PAGE_RENDER_TIMEOUT_MS); });

    expect(screen.getByRole('alert').textContent).toContain('PDF page rendering exceeded the secure review time limit.');
    expect(cancel).toHaveBeenCalledOnce();
    expect(hostilePage.cleanup).toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBeNull();
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();

    pendingRender.resolve();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('canvas')).toBeNull();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not race document cleanup against loading-task destruction after render failure', async () => {
    const failedRender = deferred<void>();
    const rejectedPage = page();
    rejectedPage.render.mockReturnValue({
      promise: failedRender.promise,
      cancel: vi.fn(),
    });
    const pdf = documentWithPages([rejectedPage]);
    pdf.cleanup.mockRejectedValue(new Error('cleanup must not race destruction'));
    const task = loadingTask(pdf);
    pdfjs.getDocument.mockReturnValue(task);
    const { onError, onRendered } = viewer();

    await waitFor(() => expect(rejectedPage.render).toHaveBeenCalledOnce());
    await act(async () => {
      failedRender.reject(new Error('render failed'));
      await Promise.resolve();
    });
    expect((await screen.findByRole('alert')).textContent).toContain('The document could not be rendered safely.');
    expect(pdf.cleanup).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not start rendering when a timed-out page lookup resolves late', async () => {
    vi.useFakeTimers();
    const plannedPage = page();
    const latePage = page();
    const pendingPage = deferred<ReturnType<typeof page>>();
    const pdf = documentWithPages([plannedPage]);
    pdf.getPage
      .mockResolvedValueOnce(plannedPage)
      .mockReturnValueOnce(pendingPage.promise);
    const task = loadingTask(pdf);
    pdfjs.getDocument.mockReturnValue(task);
    const { onError, onRendered } = viewer();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(pdf.getPage).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(PDF_PAGE_RENDER_TIMEOUT_MS); });
    pendingPage.resolve(latePage);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(latePage.render).not.toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBeNull();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('cannot let a stale render deadline destroy or erase a replacement document', async () => {
    vi.useFakeTimers();
    const pendingOldPage = deferred<ReturnType<typeof page>>();
    const oldPlanPage = page();
    const oldLatePage = page();
    const oldPdf = documentWithPages([oldPlanPage]);
    oldPdf.getPage
      .mockResolvedValueOnce(oldPlanPage)
      .mockReturnValueOnce(pendingOldPage.promise);
    const oldTask = loadingTask(oldPdf);

    const newPage = page();
    const newPdf = documentWithPages([newPage]);
    const newTask = loadingTask(newPdf);
    pdfjs.getDocument.mockReturnValueOnce(oldTask).mockReturnValueOnce(newTask);
    const oldRendered = vi.fn();
    const oldError = vi.fn();
    const nextRendered = vi.fn();
    const nextError = vi.fn();
    const base = {
      mimeType: 'application/pdf',
      label: 'National ID',
    };
    const { rerender } = render(
      <SecureDocumentViewer
        {...base}
        url="https://admin-api.test/api/v1/verification/render/old"
        reviewGrantToken="review-grant-token-old-generation-000001"
        onRendered={oldRendered}
        onError={oldError}
      />,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(oldPdf.getPage).toHaveBeenCalledTimes(2);
    rerender(
      <SecureDocumentViewer
        {...base}
        url="https://admin-api.test/api/v1/verification/render/new"
        reviewGrantToken="review-grant-token-new-generation-000001"
        onRendered={nextRendered}
        onError={nextError}
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(nextRendered).toHaveBeenCalledOnce();
    const replacementCanvas = document.querySelector('canvas');
    expect(replacementCanvas).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(PDF_PAGE_RENDER_TIMEOUT_MS); });
    pendingOldPage.resolve(oldLatePage);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(oldLatePage.render).not.toHaveBeenCalled();
    expect(newTask.destroy).not.toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBe(replacementCanvas);
    expect(oldRendered).not.toHaveBeenCalled();
    expect(oldError).not.toHaveBeenCalled();
    expect(nextRendered).toHaveBeenCalledOnce();
    expect(nextError).not.toHaveBeenCalled();
  });

  it('accepts exactly fifty ordinary pages, renders one at a time, and does not ACK after page one', async () => {
    const pages = Array.from({ length: 50 }, () => page());
    const pdf = documentWithPages(pages);
    pdfjs.getDocument.mockReturnValue(loadingTask(pdf));
    const { onRendered } = viewer();

    expect(await screen.findByText('Page 1 of 50 · reviewed 1 of 50')).toBeTruthy();
    expect(onRendered).not.toHaveBeenCalled();
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    expect(pages.filter((candidate) => candidate.render.mock.calls.length > 0)).toHaveLength(1);
    expect(pdfjs.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.any(Uint8Array),
      disableRange: true,
      disableStream: true,
    }));
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'X-Swift-Client': BROWSER_CLIENT,
        'X-Swift-Review-Grant': 'review-grant-token-for-viewer-tests-0001',
      },
    }));
  });

  it('ACKs a multi-page PDF only after every page has rendered successfully', async () => {
    const pages = [page(), page(), page()];
    pdfjs.getDocument.mockReturnValue(loadingTask(documentWithPages(pages)));
    const { onRendered } = viewer();

    const next = await screen.findByRole('button', { name: 'Next page' });
    await waitFor(() => expect(next.hasAttribute('disabled')).toBe(false));
    expect(screen.getByText('Page 1 of 3 · reviewed 1 of 3')).toBeTruthy();
    expect(onRendered).not.toHaveBeenCalled();

    fireEvent.click(next);
    await screen.findByText('Page 2 of 3 · reviewed 2 of 3');
    expect(onRendered).not.toHaveBeenCalled();
    await waitFor(() => expect(next.hasAttribute('disabled')).toBe(false));
    fireEvent.click(next);

    await waitFor(() => expect(onRendered).toHaveBeenCalledOnce());
    expect(screen.getByText('Page 3 of 3 · reviewed 3 of 3')).toBeTruthy();
  });

  it('fetches image bytes with the authenticated session and signals rendered only after decode', async () => {
    const createObjectURL = vi.fn(() => 'blob:review-image');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => jpegBytes(),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { onRendered, unmount } = viewer({ mimeType: 'image/jpeg' });

    const image = await screen.findByRole('img');
    expect(onRendered).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'X-Swift-Client': BROWSER_CLIENT,
        'X-Swift-Review-Grant': 'review-grant-token-for-viewer-tests-0001',
      },
    }));
    fireEvent.load(image);
    expect(onRendered).toHaveBeenCalledOnce();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:review-image');
  });

  it.each([
    ['image/png', () => pngBytes(MAX_RASTER_DIMENSION + 1, 1)],
    ['image/jpeg', () => jpegBytes(MAX_RASTER_DIMENSION + 1, 1)],
    ['image/webp', () => webpBytes(MAX_RASTER_DIMENSION + 1, 1)],
  ])('refuses a %s dimension bomb before creating an image decoder', async (mimeType, body) => {
    const createObjectURL = vi.fn(() => 'blob:must-not-exist');
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => body() })));
    const { onRendered, onError } = viewer({ mimeType });

    expect((await screen.findByRole('alert')).textContent).toContain('Image dimensions exceed the secure review limit.');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each([
    ['image/png', () => apngBytes()],
    ['image/webp', () => animatedWebpBytes()],
  ])('rejects animated %s evidence before creating a browser decoder', async (mimeType, body) => {
    const createObjectURL = vi.fn(() => 'blob:must-not-exist');
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => body() })));
    const { onRendered, onError } = viewer({ mimeType });

    expect((await screen.findByRole('alert')).textContent).toContain('Animated images are not permitted');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    expect(onRendered).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('spends a one-use grant only once when StrictMode replays effects', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => jpegBytes(),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:strict-image'), revokeObjectURL: vi.fn() });

    render(
      <StrictMode>
        <SecureDocumentViewer
          url="https://admin-api.test/api/v1/verification/render/strict"
          reviewGrantToken="review-grant-token-strict-mode-0000000001"
          mimeType="image/jpeg"
          label="National ID"
          onRendered={vi.fn()}
          onError={vi.fn()}
        />
      </StrictMode>,
    );

    await screen.findByRole('img');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refetches the same render path when the server rotates the grant token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => jpegBytes(),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:rotated-image'), revokeObjectURL: vi.fn() });
    const props = {
      url: 'https://admin-api.test/api/v1/verification/render/same',
      mimeType: 'image/jpeg',
      label: 'National ID',
      onRendered: vi.fn(),
      onError: vi.fn(),
    };
    const { rerender } = render(
      <SecureDocumentViewer {...props} reviewGrantToken="review-grant-token-generation-one-000001" />,
    );
    await screen.findByRole('img');
    rerender(<SecureDocumentViewer {...props} reviewGrantToken="review-grant-token-generation-two-00002" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ 'X-Swift-Review-Grant': 'review-grant-token-generation-two-00002' }),
    }));
  });
});
