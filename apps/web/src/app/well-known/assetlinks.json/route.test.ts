import { afterEach, describe, expect, it, vi } from 'vitest';

// Android App Links verification: the phone fetches this file at install and
// compares each sha256_cert_fingerprints entry with the certificate that
// signed the installed app. Google's format is 32 upper-case hex pairs joined
// by colons. A wrong entry never matches, so it is dead weight at best; when
// every entry is wrong the file is a fake association. The route therefore
// publishes only well-formed fingerprints and keeps the honest 404 otherwise.

const PLAY = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const UPLOAD = '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF';

async function serve(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) vi.stubEnv('ANDROID_CERT_SHA256', undefined as unknown as string);
  else vi.stubEnv('ANDROID_CERT_SHA256', value);
  const { GET } = await import('./route');
  return GET();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/.well-known/assetlinks.json', () => {
  it('is an honest 404 while no fingerprint is configured', async () => {
    expect((await serve(undefined)).status).toBe(404);
    expect((await serve('')).status).toBe(404);
    expect((await serve(' , ')).status).toBe(404);
  });

  it('publishes the Play app-signing and upload fingerprints for gy.swift.app, in order', async () => {
    const res = await serve(`${PLAY}, ${UPLOAD}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'gy.swift.app', sha256_cert_fingerprints: [PLAY, UPLOAD] },
      },
    ]);
  });

  it('writes a lower-case fingerprint in the upper-case form Android compares', async () => {
    const res = await serve(PLAY.toLowerCase());
    expect((await res.json())[0].target.sha256_cert_fingerprints).toEqual([PLAY]);
  });

  it('drops a malformed entry and keeps the good one', async () => {
    // A SHA-1 (20 pairs), a fingerprint without colons and a placeholder are
    // all real-world paste mistakes; none of them can ever verify.
    const sha1 = '9F:2B:06:32:03:A5:15:F8:6F:A9:66:D6:08:D1:65:2E:7B:33:F8:6A';
    const res = await serve([sha1, PLAY.replace(/:/g, ''), 'REPLACE_ME', UPLOAD].join(','));
    expect(res.status).toBe(200);
    expect((await res.json())[0].target.sha256_cert_fingerprints).toEqual([UPLOAD]);
  });

  it('stays a 404 when every entry is malformed, never a fake association', async () => {
    expect((await serve('9F:2B:06:32:03:A5:15:F8:6F:A9:66:D6:08:D1:65:2E:7B:33:F8:6A')).status).toBe(404);
    expect((await serve('REPLACE_WITH_RELEASE_SHA256')).status).toBe(404);
  });
});
