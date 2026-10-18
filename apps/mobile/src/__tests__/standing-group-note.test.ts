/** [COORD 18 Oct, option S] The Standing card explains that a person's figures move only in whole groups. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { standingGroupNote } from '../components/standingNote';

describe("a person's Standing card (groups of ratings)", () => {
  it('says each bar is a group and the rating moves only after a whole group', () => {
    expect(standingGroupNote(5)).toBe('Each bar is 5 ratings. Your rating moves only after every 5, so no rating can be matched to one trip.');
  });
  it('says nothing for a store (no groupSize) or a nonsense size', () => {
    expect(standingGroupNote(undefined)).toBeNull();
    expect(standingGroupNote(1)).toBeNull();
  });
  it('the card shows the note from the server groupSize', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'StandingCard.tsx'), 'utf8');
    expect(src).toContain('const groupNote = standingGroupNote(data.groupSize);');
    expect(src).toContain('{groupNote}');
  });
});
