import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// ---------------------------------------------------------------------------
// [A-06 / D-11] ABSENCE OF DATA IS NOT EVIDENCE OF ABSENCE.
//
// An operations surface that renders "all clear", "no alerts", "no orders" or
// a zero when its READ FAILED tells an operator the platform is quiet at the
// exact moment they are blind. The register names four of these on the admin
// dashboard and one on the desktop health page.
//
// The admin half is graded by rendering tests in apps/admin. The DESKTOP app
// has no test runner at all — adding one means new dependencies and a lockfile
// change, which is its own item — so its half is graded here, as a source
// census, in an app whose suite already runs in CI. That is stated rather than
// left as an unguarded fix.
// ---------------------------------------------------------------------------

const REPO = resolve(process.cwd(), '../..');
const DESKTOP_HEALTH = join(REPO, 'apps/desktop/src/modules/Health.tsx');
const ADMIN = join(REPO, 'apps/admin/src/components/dashboard');

/** Comments quote the very sentences this census hunts for, so they go first. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

function source(path: string): string {
  expect(existsSync(path), `${path} does not exist — this census would pass blind`).toBe(true);
  const text = stripComments(readFileSync(path, 'utf8'));
  expect(text.trim().length, `${path} is empty after stripping — this census would pass blind`).toBeGreaterThan(200);
  return text;
}

describe('[D-11] the desktop health page never reports a quiet system it cannot see', () => {
  const health = source(DESKTOP_HEALTH);

  it('the reassuring sentence is gated on the read having SUCCEEDED', () => {
    // "No alerts sent in the window." may only render when the query is neither
    // failing nor still loading.
    const quiet = health.indexOf('No alerts sent in the window');
    expect(quiet, 'the empty-state sentence is gone entirely — expected it, gated').toBeGreaterThan(0);
    const guard = health.slice(Math.max(0, quiet - 400), quiet);
    expect(guard).toMatch(/!alerts\.isError/);
    expect(guard).toMatch(/!alerts\.isLoading/);
  });

  it('a failed read renders an explicit unavailable state that denies being an all-clear', () => {
    // the POSITIVE branch specifically — `!alerts.isError &&` in the empty-state
    // guard also matches a looser pattern, which is how this test first missed
    // a mutation that deleted the unavailable block outright
    expect(health).toMatch(/\{alerts\.isError && \(/);
    expect(health).toMatch(/could not be read/i);
    expect(health).toMatch(/NOT ["“]?no alerts/i);
  });

  it('and it says when the last successful read was', () => {
    expect(health).toMatch(/alerts\.dataUpdatedAt/);
  });

  it('the pattern the file already had is untouched: the DLQ still surfaces its own error', () => {
    expect(health).toMatch(/dlq\.isError &&/);
    expect(health).toMatch(/health\.isError \?/);
  });
});

describe('[A-06] no admin dashboard panel invents an absence', () => {
  it('each panel that can be blind takes an unavailable state and renders the shared component', () => {
    for (const file of ['AlertsPanel.tsx', 'RevenueBreakdown.tsx', 'LiveOrderFeed.tsx']) {
      const text = source(join(ADMIN, file));
      expect(text, `${file} must render the shared unavailable state`).toMatch(/DataUnavailable/);
    }
  });

  it('the reassuring sentences survive, but only behind that state', () => {
    const alerts = source(join(ADMIN, 'AlertsPanel.tsx'));
    // "All clear" is still the right words for a genuinely quiet platform —
    // it just cannot be the fallback for a failed read any more.
    expect(alerts).toMatch(/All clear/);
    expect(alerts.indexOf('unavailable ?')).toBeLessThan(alerts.indexOf('All clear'));

    const feed = source(join(ADMIN, 'LiveOrderFeed.tsx'));
    expect(feed).toMatch(/No recent orders/);
    expect(feed).toMatch(/blind \? \(/);
  });

  it('a projection is never multiplied out of a total the page does not have', () => {
    const revenue = source(join(ADMIN, 'RevenueBreakdown.tsx'));
    const projection = revenue.indexOf('Monthly Projection');
    expect(projection).toBeGreaterThan(0);
    const guard = revenue.slice(Math.max(0, projection - 300), projection);
    // A-06: the read FAILED — the page is blind and must project nothing.
    expect(guard).toMatch(/!unavailable/);
    // [A-07] and the read SUCCEEDED but the field did not come. That is a
    // different absence, and `weeklyTotal || 0` used to turn it into an
    // authoritative zero which the projection then multiplied. Graded on the
    // guard's meaning rather than on one literal spelling of it, which is what
    // made this assertion break when the guard got STRONGER.
    expect(guard).toMatch(/weeklyTotal !== undefined/);
    expect(guard).toMatch(/weeklyTotal !== null/);
  });

  it('the shared component says the two things an operator needs', () => {
    const shared = source(join(ADMIN, 'DataUnavailable.tsx'));
    expect(shared).toMatch(/could not be loaded/);
    expect(shared).toMatch(/lastSuccessAt/);
    expect(shared).toMatch(/role="status"/);
  });
});
