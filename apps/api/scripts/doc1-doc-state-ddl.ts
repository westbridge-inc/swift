/**
 * [DOC-1 P5-1] Print the state-machine migration: the hand-written schema header plus
 * the DDL generated from `doc-state.ts`. Re-run after editing DOC_TRANSITIONS and paste
 * the output into a NEW migration — `doc1-state-machine.test.ts` asserts the latest
 * migration mirrors the generator verbatim.
 */
import { DOC_STATE_MIGRATION_HEADER, docStateMachineDdl } from '../src/modules/verification/doc-state';

process.stdout.write(DOC_STATE_MIGRATION_HEADER + '\n' + docStateMachineDdl().join('\n\n') + '\n');
