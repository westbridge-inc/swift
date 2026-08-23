// Android App Links verification [QR deep-links, qr spec Part 6]: Android
// fetches this at install to verify the autoVerify intent filters; matching
// links then open the app directly. 404 until ANDROID_CERT_SHA256 (the
// RELEASE keystore's SHA-256, colon-separated; comma-separate multiple) is
// provided — an honest absence, never a fake association. Served at
// /.well-known/assetlinks.json via the rewrite in next.config.ts.

export const dynamic = 'force-dynamic';

const SHA256 = process.env['ANDROID_CERT_SHA256'];
const PACKAGE = process.env['ANDROID_PACKAGE'] ?? 'gy.swift.app';

export function GET() {
  if (!SHA256) return new Response(null, { status: 404 });
  const fingerprints = SHA256.split(',').map((s) => s.trim()).filter(Boolean);
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
