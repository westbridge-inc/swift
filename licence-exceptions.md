# Licence exceptions — DOC-1 §26.1 / DOC-INV-23

The CI licence gate (`scripts/licence-gate.mjs`) fails the build on any installed dependency whose licence is outside the allowlist (MIT/ISC/BSD/Apache-2.0/MPL-2.0 and the other permissive SPDX ids in the script) unless the package is named here with a reason. A row is a decision, not a waiver: it says why the licence is acceptable for a SaaS deployment that does not distribute the code.

| Package | Licence | Reason |
|---|---|---|
| `react-leaflet` | Hippocratic-2.1 | Admin console map wrapper only; used in-house, not distributed; Leaflet itself is BSD-2. Replace with a direct Leaflet binding if ever distributed. |
| `@react-leaflet/core` | Hippocratic-2.1 | Same package family as react-leaflet (above); same reasoning. |
| `@img/sharp-*` | LGPL-3.0-or-later (libvips prebuilt binaries; some rows Apache-2.0 AND LGPL-3.0) | Pulled transitively by `sharp` (Next.js image tooling / Expo build tooling). LGPL permits using the unmodified shared library; Swift neither modifies nor distributes it, and it never runs in the mobile app. Revisit if sharp is ever bundled into a distributed artifact. |
| `png-js` | no licence field in the manifest | Transitive of pdfkit (PDF rendering). Upstream repository states MIT; the manifest omits the field. Non-distributed server use. |
| `buffers` | no licence field in the manifest | Transitive of `chainsaw` (an old stream helper). Upstream MIT/X11; manifest omits the field. |
| `chainsaw` | MIT/X11 (non-SPDX spelling) | Normalised to MIT by the gate; listed so the classification is explicit. |
| `traverse` | MIT/X11 (non-SPDX spelling) | Normalised to MIT by the gate; listed so the classification is explicit. |

