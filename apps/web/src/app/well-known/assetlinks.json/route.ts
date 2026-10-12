// Android App Links verification [QR deep-links, qr spec Part 6]: Android
// fetches this at install to verify the autoVerify intent filters; matching
// links then open the app directly. 404 until ANDROID_CERT_SHA256 is provided
// — an honest absence, never a fake association. Served at
// /.well-known/assetlinks.json via the rewrite in next.config.ts.
//
// ANDROID_CERT_SHA256 holds SHA-256 certificate fingerprints, colon-separated,
// comma-separated when there are several: the Play app-signing key (it signs
// every copy installed from Play) and the upload key (it signs EAS builds).
// The deploy stack hands it to this container (deploy/docker-compose.yml).
// Android compares 32 upper-case hex pairs; an entry of any other shape can
// never verify, so it is dropped, and with none left the answer stays 404.

export const dynamic = 'force-dynamic';

const SHA256 = process.env['ANDROID_CERT_SHA256'];
const PACKAGE = process.env['ANDROID_PACKAGE'] ?? 'gy.swift.app';

const FINGERPRINT = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;

export function GET() {
  const fingerprints = (SHA256 ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => FINGERPRINT.test(s));
  if (fingerprints.length === 0) return new Response(null, { status: 404 });
  return Response.json(
    [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: PACKAGE,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ],
    { headers: { 'cache-control': 'public, max-age=3600' } },
  );
}
