-- [INAPP-CALLS · owner 6 Nov 2026, "B"] In-app calling writes its attempts into the call bridge's own
-- table (one row per attempt, never a phone number, one budget per order), with ONE new state:
-- RINGING_APP (the caller's phone started the call; the other person's Swift app rings).
-- EXPAND only: the status CHECK gains one value; every existing row already satisfies it.
-- INERT while INAPP_CALLS is off: no row is ever written with the new value.
--
-- ROLLBACK: rollback.sql beside this file. It refuses while any row is RINGING_APP.

SET lock_timeout = '10s';

ALTER TABLE "call_sessions" DROP CONSTRAINT "call_sessions_status_check";
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_status_check"
  CHECK ("status" IN ('DIALING_CALLER', 'CALLER_CONFIRMED', 'CONNECTED', 'NOT_CONNECTED', 'FAILED', 'RINGING_APP'));
