# FG-2 — Deletion candidates (FOUNDER APPROVAL REQUIRED before anything is removed)

Compiled 2026-08-23 during the REPORT-029 sweep (UXR-W-005). Law: nothing is
deleted without founder approval; each row lists the evidence and the blast
radius. Approve rows individually.

| # | Candidate | Evidence | Blast radius / prerequisite |
|---|---|---|---|
| 1 | `apps/mobile/src/kit/ride-sheet.tsx` (RideSheet) | TRUE ORPHAN — zero imports anywhere; only its own file mentions it (grep 08-23) | None. Delete is a pure code removal. |
| 2 | `apps/mobile/src/screens/shared/ChatScreen.tsx` (legacy order chat) | WR-025: its Send is DEAD in the room-failure state; superseded by `modules/chat/ConversationScreen` (full error/retry states) | Still ROUTED: CustomerStack:129 + MoverStack register `name="Chat"`; movement/mover flows `navigate('Chat')`. Prerequisite: re-point those callers to `Conversation` (params: orderId,title match), keep a route alias so old pushes never 404 (alias law). |
| 3 | Toothed-edge family remnants | Family deleted in #717/#719; veto note lives in `kit/docket.tsx` | Verify no stragglers at approval time (grep `tooth` clean as of #719). Nothing further to delete unless a straggler surfaces. |
| 4 | `apps/admin/src/lib/utils.ts` (REPORT-022 A1) | RE-VERIFIED 08-23 on the live tree: **zero** importers of `lib/utils` anywhere in `apps/admin/src`. The raw-name hits REPORT-022 mentions are independent implementations in mobile/packages, not references. | None — pure removal. |
| 5 | `apps/mobile/src/modules/onboarding/OnboardingScreen.tsx` (REPORT-022 A2) | RE-VERIFIED 08-23: the only `OnboardingScreen` hits are **`MoverOnboardingScreen`**, a different live component (substring coincidence — exactly the trap to check). No importer of this file. Not an Expo file-based entry path. | None — pure removal. Confirm at approval time that no new consumer appeared. |
| 6 | `packages/types/src/courier.ts` + `packages/types/src/rides.ts` (REPORT-022 A3/A4) | RE-VERIFIED 08-23: neither file appears in the package barrel (`packages/types/src/index.ts`) and neither has a direct/subpath importer. Type-only files. | None — pure removal, but they are the kind of file a future feature reaches for; deleting is cheap to reverse from git if MKT-1 wants them. |

| 7 | `apps/mobile/src/components/ui/avatar.tsx` (shared `Avatar`) | FOUND 08-23 while working F-267: exported from the `components/ui` barrel but **zero** `<Avatar` usages and zero importers anywhere. Both real consumers (`HomeScreen`, `ProfileScreen`) hand-roll their own avatar with an `onError`→monogram fallback that this component lacks. | Either DELETE, or (better) consume it in those two screens first and give it the `onError` fallback — one avatar language instead of two copies. Founder picks which; do not polish an orphan. |

| 8 | `apps/admin/src/components/MutationNotice.tsx` | The `admin-tests` lane replaced it with `MutationError.tsx` and DELETED it. I restored the file: nothing is removed without founder approval. Verified 08-24: after the lane's work landed, `grep -rn MutationNotice apps/admin/src` matches only its own definition — zero importers. | None — pure removal. It is superseded in function by `MutationError`, which every page now uses. Approve and it goes; decline and it simply sits unused. |

REPORT-022's Tier B/C (dead exports inside live files, do-not-delete traps)
are deliberately NOT proposed here: Tier B is symbol-level surgery inside
files that are alive, and Tier C is explicitly "do not delete". Those want
their own reviewed pass, not a bulk approval.

Recommended: approve #1 immediately (zero risk); approve #2 as "re-route then
delete" in one PR; #3 is already done — listed for the record; #4–#6 are
zero-referrer files re-verified tonight and safe to approve together.
