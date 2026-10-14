import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The partner account lists the weekly fee ONCE (owner, 11 Oct: the driver
// account showed "Weekly fee" twice, a status row and a link row). The one
// row carries the rate and the status pill and opens the Weekly fee screen.

const screen = readFileSync(join(process.cwd(), 'src/modules/mover/screens/MoverAccountScreen.tsx'), 'utf8');
// One entry per <SettingsRow>, up to the next row or the card's end (a row
// can contain its own self-closing children, such as the status pill).
const rows = screen.split('<SettingsRow').slice(1).map((seg) => seg.split(/<SettingsRow|<\/Card>/)[0]!);

describe('the mover account weekly-fee row', () => {
  it('appears exactly once', () => {
    expect(rows.length, 'no settings rows parsed').toBeGreaterThan(3);
    expect(rows.filter((row) => row.includes('label="Weekly fee"'))).toHaveLength(1);
  });

  it('shows the rate and status and opens the Weekly fee screen', () => {
    const row = rows.find((r) => r.includes('label="Weekly fee"'))!;
    expect(row).toContain('usdDisplay?.line');
    expect(row).toContain('<TonePill label={subPill.label} tone={subPill.tone} />');
    expect(row).toContain("onPress={() => navigation?.navigate?.('WeeklyFee')}");
  });
});
