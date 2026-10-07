import axios, { type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { installPreviewWriteGuard, isWriteMethod, PREVIEW_READ_ONLY, PREVIEW_READ_ONLY_MESSAGE, PreviewReadOnlyError } from './previewWriteGuard';

function client(showing: () => boolean) {
  const sent: string[] = [];
  const c = axios.create();
  c.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    sent.push(`${String(config.method).toUpperCase()} ${config.url}`);
    return { config, status: 200, statusText: 'OK', headers: {}, data: {} };
  };
  // A synchronous interceptor installed BEFORE the guard, like the app's auth
  // interceptor: the guard must hold whatever else is on the chain.
  c.interceptors.request.use((config) => config, undefined, { synchronous: true });
  installPreviewWriteGuard(c, showing);
  return { c, sent };
}

describe('preview write guard', () => {
  it('reads are GET, HEAD and OPTIONS; everything else writes', () => {
    for (const m of ['get', 'GET', 'head', 'options', undefined]) expect(isWriteMethod(m), String(m)).toBe(false);
    for (const m of ['post', 'put', 'patch', 'delete', 'DELETE', 'purge']) expect(isWriteMethod(m), m).toBe(true);
  });

  it('while showing, a write is refused on the phone and never reaches the transport', async () => {
    const { c, sent } = client(() => true);
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const refusal = await c.request({ method, url: `/w/${method}` }).then(() => null, (e: unknown) => e);
      expect(refusal).toBeInstanceOf(PreviewReadOnlyError);
      expect(refusal).toMatchObject({ code: PREVIEW_READ_ONLY, message: PREVIEW_READ_ONLY_MESSAGE, method: method.toUpperCase(), url: `/w/${method}` });
    }
    await c.get('/r/get');
    await c.head('/r/head');
    expect(sent).toEqual(['GET /r/get', 'HEAD /r/head']);
  });

  it('follows the preview on and off without reinstalling', async () => {
    let showing = false;
    const { c, sent } = client(() => showing);
    await c.post('/before');
    showing = true;
    await expect(c.post('/during')).rejects.toBeInstanceOf(PreviewReadOnlyError);
    showing = false;
    await c.post('/after');
    expect(sent).toEqual(['POST /before', 'POST /after']);
  });

  it('a read never asks whether the preview is showing', async () => {
    let asked = 0;
    const { c } = client(() => { asked += 1; return true; });
    await c.get('/r');
    expect(asked).toBe(0);
  });
});
