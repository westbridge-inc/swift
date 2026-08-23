# FG-2 — Deletion candidates (FOUNDER APPROVAL REQUIRED before anything is removed)

Compiled 2026-08-23 during the REPORT-029 sweep (UXR-W-005). Law: nothing is
deleted without founder approval; each row lists the evidence and the blast
radius. Approve rows individually.

| # | Candidate | Evidence | Blast radius / prerequisite |
|---|---|---|---|
| 1 | `apps/mobile/src/kit/ride-sheet.tsx` (RideSheet) | TRUE ORPHAN — zero imports anywhere; only its own file mentions it (grep 08-23) | None. Delete is a pure code removal. |
| 2 | `apps/mobile/src/screens/shared/ChatScreen.tsx` (legacy order chat) | WR-025: its Send is DEAD in the room-failure state; superseded by `modules/chat/ConversationScreen` (full error/retry states) | Still ROUTED: CustomerStack:129 + MoverStack register `name="Chat"`; movement/mover flows `navigate('Chat')`. Prerequisite: re-point those callers to `Conversation` (params: orderId,title match), keep a route alias so old pushes never 404 (alias law). |
| 3 | Toothed-edge family remnants | Family deleted in #717/#719; veto note lives in `kit/docket.tsx` | Verify no stragglers at approval time (grep `tooth` clean as of #719). Nothing further to delete unless a straggler surfaces. |

Recommended: approve #1 immediately (zero risk); approve #2 as "re-route then
delete" in one PR; #3 is already done — listed for the record.
