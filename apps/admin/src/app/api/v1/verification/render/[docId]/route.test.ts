import { describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET } from './route';

// [DS110-15] The render proxy serves partner-uploaded bytes on the admin
// origin. It relays only the upload formats, keeps upstream refusals as
// refusals, and never reaches anywhere but the configured API.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function call(docId: string, search = '?expires=1&sig=signed-token-value') {
  const request = { nextUrl: new URL(`http://admin.test/api/v1/verification/render/${docId}${search}`) } as unknown as NextRequest;
  return GET(request, { params: Promise.resolve({ docId }) });
}

function upstream(body: BodyInit | null, init: ResponseInit) {
  const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(body, init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('[DS110-15] verification render proxy', () => {
  it('relays an uploaded image from the configured API, inline and uncached', async () => {
    const fetchMock = upstream(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    const res = await call('doc_1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://admin-api.test/api/v1/verification/render/doc_1?expires=1&sig=signed-token-value');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('relays a PDF certificate', async () => {
    upstream('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } });
    const res = await call('doc_2');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
  });

  it.each([
    ['text/html; charset=utf-8', '<script>parent.postMessage(document.cookie, "*")</script>'],
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['application/octet-stream', 'raw'],
  ])('refuses %s instead of serving it on the admin origin', async (type, body) => {
    upstream(body, { status: 200, headers: { 'content-type': type } });
    const res = await call('doc_3');
    expect(res.status).toBe(415);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = await res.text();
    expect(text).not.toContain('<script>');
  });

  it.each([403, 410, 404])('keeps an upstream %i a refusal, without relaying its body', async (status) => {
    upstream(JSON.stringify({ success: false, error: { code: 'DOCUMENT_PURGED' } }), { status, headers: { 'content-type': 'application/json' } });
    const res = await call('doc_4');
    expect(res.status).toBe(status);
    expect(res.ok).toBe(false);
    expect(await res.text()).toBe('');
  });

  it.each(['..', 'a/b', 'doc%2F..', 'x'.repeat(65)])('rejects the id %s without calling the API', async (docId) => {
    const fetchMock = upstream(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    const res = await call(docId);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
