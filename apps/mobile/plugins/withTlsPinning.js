/* eslint-env node */
/**
 * Android TLS pinning for the production API domain, mirroring the iOS
 * NSPinnedDomains entry in app.config.ts. Writes res/xml/network_security_config.xml
 * with a <pin-set> for api.swift.gy (Let's Encrypt root SPKI hashes, ISRG
 * Root X1 + X2) and points the manifest at it.
 *
 * The pin-set carries an expiration: if the app ships past that date without
 * an update, Android falls back to normal CA validation instead of bricking
 * connectivity — fail-open by design for a cash-critical marketplace.
 * Dev builds and non-pinned domains are unaffected.
 */
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config>
    <domain includeSubdomains="true">api.swift.gy</domain>
    <pin-set expiration="2028-07-01">
      <!-- ISRG Root X1 (Let's Encrypt), SPKI SHA-256 -->
      <pin digest="SHA-256">C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=</pin>
      <!-- ISRG Root X2 (Let's Encrypt), SPKI SHA-256 -->
      <pin digest="SHA-256">diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=</pin>
      <!-- [V4] BACKUP CA: GTS Root R1 (Google Trust Services), SPKI SHA-256,
           computed 2026-08-25 from https://pki.goog/repo/certs/gtsr1.pem.
           Pinning only the live CA is a scheduled outage: a CA switch (or LE
           retiring these roots) would strand every installed build with no
           server-side remedy. GTS is the designated fallback issuer.
           ROTATION IS A RELEASE CHECKLIST ITEM — revisit by 2027-07-01, a
           year ahead of the hard expiration above. Mirrored on iOS in
           app.config.ts NSPinnedCAIdentities. -->
      <pin digest="SHA-256">hxqRlPTu1bMS/0DITB1SSu0vd4u/8l8TjPgfaAp63Gc=</pin>
    </pin-set>
  </domain-config>
  <!-- Declaring networkSecurityConfig REPLACES the platform default, and with
       targetSdk >= 28 the implicit base blocks ALL cleartext — which silently
       cut every debug build off from Metro (localhost/10.0.2.2), the reason
       Android never loaded a bundle. These hosts are loopback/emulator-NAT
       only and unreachable in production; the pin-set above is untouched. -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">10.0.3.2</domain>
  </domain-config>
</network-security-config>
`;

function withTlsPinning(config) {
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const xmlDir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), NETWORK_SECURITY_CONFIG);
      return cfg;
    },
  ]);

  config = withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (application) {
      application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    }
    return cfg;
  });

  return config;
}

module.exports = withTlsPinning;
