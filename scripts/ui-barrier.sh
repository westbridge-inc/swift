#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# THE UI BARRIER [SWIFT-UI-GUT-AND-REBUILD §7.2]
#
# An ESLint rule can be silenced with an inline disable comment. A grep gate in
# CI cannot be silenced quietly — removing it shows up in the diff.
#
# What it protects: Swift has (or had) TWO design systems in one app, and 15 of
# the busiest screens imported both. The new tree — kit2/ + screens2/ — is built
# clean and cut over one surface at a time. This gate is what keeps it clean
# while that happens, and what stops a second palette ever reappearing.
# ---------------------------------------------------------------------------
set -uo pipefail

fail=0
leak() { echo "❌ BARRIER VIOLATION: $1"; fail=1; }

MOBILE=apps/mobile/src

# ── Phase 1-8: the new tree must stay clean ────────────────────────────────
if [ -d "$MOBILE/kit2" ] || [ -d "$MOBILE/screens2" ]; then
  if grep -rn "components/ui" "$MOBILE/kit2" "$MOBILE/screens2" 2>/dev/null; then
    leak "kit2/screens2 imports the legacy kit"
  fi
  if grep -rnE "from '(\.\./)+kit'" "$MOBILE/kit2" "$MOBILE/screens2" 2>/dev/null; then
    leak "kit2/screens2 imports the old kit"
  fi
fi

# ── THE AMPUTATION IS DONE — and it stays done [C6/S10 step 5] ─────────────
# The legacy kit was removed on 2026-08-26 after its nine unique primitives
# were authored into the kit (#796) and every import migrated. From here this
# is a HARD one-way door: the folder must not return, and nothing may import
# or require it. (Doc comments that merely NAME the old path are fine — the
# gate matches the module-resolution forms.)
if [ -d "$MOBILE/components/ui" ]; then
  leak "components/ui has RETURNED — the second design system was amputated; author what you need in src/kit"
fi
if grep -rnE "(from ['\"][^'\"]*components/ui|require\(['\"][^'\"]*components/ui)" "$MOBILE" 2>/dev/null; then
  leak "something imports the deleted legacy kit — use src/kit"
fi

# ── Permanent, from day one: nobody re-introduces a second palette ─────────
# The brand hexes live in packages/ui and nowhere else. A hardcoded #803B3B is
# how a third design system starts.
if grep -rnE "#(803B3B|5C2A2C|F5EBEC|FBFBF9|211A1A)" \
     apps/mobile/src apps/web/src apps/admin/src apps/desktop/src \
     --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v 'packages/ui'; then
  leak "brand hex hardcoded outside packages/ui — use @swift/ui tokens"
fi

if [ "$fail" -eq 0 ]; then echo "✅ UI barrier holds"; fi
exit $fail
