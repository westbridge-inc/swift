-- Rollback of 20261011190000_doc_state_replace_pending: the two replace transitions leave the table.
-- Copies already SUPERSEDED by a replacement stay as they are (a terminal, purgeable state).
DELETE FROM doc_state_transition WHERE ("fromState", "toState") IN (('REVIEW_QUEUED', 'SUPERSEDED'), ('IN_REVIEW', 'SUPERSEDED'));
