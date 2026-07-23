// Shared @fastify/helmet configuration. server.ts registers helmet with this,
// and the header-posture regression test (SWIFT-134, from the 2026-07-16 security
// audit P2 backlog) asserts against the SAME object — so the CSP, HSTS, and the
// sniff/framing protections can't quietly drift away from the test that guards
// them. connect-src allows the realtime socket (ws/wss) alongside self.
export const helmetOptions = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'wss:', 'ws:'],
    },
  },
};
