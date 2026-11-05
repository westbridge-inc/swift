import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENUM_LABELS } from '@/lib/labels';
import {
  DECISION_WORDS, INCIDENT_TRANSITIONS, SOS_RESOLUTION_CODES, SOS_TRANSITIONS, clocksFor, queueOrder, slaClock, sosActions, sosNotes, sosPosition, sosPressesNotShown, worstSla,
  type IncidentRow, type SosRow,
} from '@/lib/safetyView';

// ---------------------------------------------------------------------------
// [SAFETY BOARD] The console restates the server's rules ONLY to stop offering what would be refused. These tests read the
// server's own source, so a server change turns this red. The desktop list this page was copied from has already drifted:
// it offers SAFE and UNREACHABLE, which the server answers with a 400.
// ---------------------------------------------------------------------------

const api = (file: string) => readFileSync(join(process.cwd(), '..', 'api', 'src', 'modules', 'safety', file), 'utf8');
function transitions(source: string, name: string): Record<string, string[]> {
  const block = source.match(new RegExp(`export const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\};`))![1]!;
  return Object.fromEntries([...block.matchAll(/^\s*(\w+): \[([^\]]*)\]/gm)].map((m) => [m[1]!, [...m[2]!.matchAll(/'(\w+)'/g)].map((v) => v[1]!)]));
}

describe('[SAFETY BOARD] the rules match the server', () => {
  it('the SOS state machine', () => {
    expect(SOS_TRANSITIONS).toEqual(transitions(api('sos.service.ts'), 'SOS_TRANSITIONS'));
  });
  it('the case state machine', () => {
    expect(INCIDENT_TRANSITIONS).toEqual(transitions(api('incident.service.ts'), 'INCIDENT_TRANSITIONS'));
  });
  it('the decisions', () => {
    const codes = api('incident.service.ts').match(/export const DECISION_CODES = \[([^\]]*)\]/)![1]!;
    expect(Object.keys(DECISION_WORDS)).toEqual([...codes.matchAll(/'(\w+)'/g)].map((v) => v[1]!));
  });
  it('the resolution codes the route takes', () => {
    const codes = api('safety.routes.ts').match(/resolutionCode: z\.enum\(\[([^\]]*)\]/)![1]!;
    expect([...SOS_RESOLUTION_CODES]).toEqual([...codes.matchAll(/'(\w+)'/g)].map((v) => v[1]!));
    expect(Object.keys(ENUM_LABELS.SosResolutionCode)).toEqual([...SOS_RESOLUTION_CODES]);
  });
  it('the roles the safety routes call ops are the ones the console lets in', () => {
    expect(api('safety.routes.ts')).toContain("const isOps = (role: string) => role === 'ADMIN' || role === 'SUPER_ADMIN';");
    const shell = readFileSync(join(process.cwd(), 'src', 'components', 'layout', 'AppShell.tsx'), 'utf8');
    expect(shell).toContain("roles.some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN')");
  });
});

const alert = (over: Partial<SosRow> = {}): SosRow => ({
  id: 'sos-1', actorUserId: 'u1', actorRole: 'CUSTOMER', status: 'ACTIVE', orderId: null, orderType: null, serviceJobId: null, counterpartyUserId: null, triggeredAt: '2026-11-05T14:00:00.000Z',
  triggerSource: 'BUTTON', triggerLat: null, triggerLng: null, triggerAddressText: null, triggerNote: null, retriggers: null, userSafeFlaggedAt: null, acknowledgedAt: null, retriggerCount: 0, ...over,
});
const row = (over: Partial<IncidentRow> = {}): IncidentRow => ({
  id: 'c', caseNumber: 'INC-1', status: 'OPEN', severity: 'S2', category: 'OTHER', summary: 'Something happened.', subjectUserId: 'u', orderId: null, sosAlertId: null, escalatedPoliceAt: null,
  legalHold: false, interimAction: 'NONE', slaAckBy: '2026-11-05T15:00:00.000Z', slaDecideBy: '2026-11-06T15:00:00.000Z', ackedAt: null, decidedAt: null, closedAt: null, decisionCode: null,
  createdAt: '2026-11-05T14:00:00.000Z', ...over,
});

describe('[SAFETY BOARD] what the board reads', () => {
  it('an SOS: acknowledge only from live, resolve from live or acknowledged', () => {
    expect(sosActions(alert({ status: 'TRIGGER_PENDING' }))).toEqual([]);
    expect(sosActions(alert({ status: 'ACTIVE' }))).toEqual(['ack', 'resolve']);
    expect(sosActions(alert({ status: 'ACKNOWLEDGED' }))).toEqual(['resolve']);
    expect(sosActions(alert({ status: 'RESOLVED' }))).toEqual([]);
    expect(sosActions(alert({ status: 'CANCELLED' }))).toEqual([]);
  });

  it('the words: oldest first, nothing rewritten, blanks dropped, a feed is not a type system', () => {
    const a = alert({ triggerNote: ' first ', retriggers: [{ seq: 2, at: 'b', note: 'third' }, { seq: 1, at: 'a', note: '   ' }, { seq: 3, at: 'c' }] });
    expect(sosNotes(a).map((n) => [n.seq, n.text])).toEqual([[0, 'first'], [2, 'third']]);
    expect(sosNotes(alert({ retriggers: 'nonsense' as never }))).toEqual([]);
  });

  it('counts the repeat presses the summary no longer carries', () => {
    expect(sosPressesNotShown(alert({ retriggerCount: 25, retriggers: [{ seq: 25, at: 'x' }] }))).toBe(24);
    expect(sosPressesNotShown(alert({ retriggerCount: 0 }))).toBe(0);
  });

  it('the position: the newest press that had one, else the first, else none', () => {
    expect(sosPosition(alert())).toEqual({ newest: null, first: null });
    const first = { triggerLat: 6.8, triggerLng: -58.1 };
    expect(sosPosition(alert(first)).first).toEqual({ text: '6.80000, -58.10000' });
    expect(sosPosition(alert({ ...first, triggerAddressText: 'Water Street' })).first).toEqual({ text: 'Water Street' });
    const moved = alert({ ...first, retriggers: [{ seq: 1, at: 'a', lat: 6.9, lng: -58.2 }, { seq: 2, at: 'b', addressText: 'Camp Street' }, { seq: 3, at: 'c' }] });
    expect(sosPosition(moved).newest).toEqual({ text: 'Camp Street', seq: 2, at: 'b' });
    expect(sosPosition(alert({ retriggers: [{ seq: 1, at: 'a', lat: 0, lng: 0 }] })).newest?.text).toBe('0.00000, 0.00000');
  });

  it('a clock reads from the deadline and the stamp that stops it, never the status', () => {
    const now = new Date('2026-11-05T14:00:00.000Z');
    expect(slaClock('Ack', '2026-11-05T13:59:00.000Z', null, now).state).toBe('breached');
    expect(slaClock('Ack', '2026-11-05T14:10:00.000Z', null, now).state).toBe('due');
    expect(slaClock('Ack', '2026-11-05T16:00:00.000Z', null, now).state).toBe('ok');
    expect(slaClock('Ack', '2026-11-05T13:00:00.000Z', '2026-11-05T12:00:00.000Z', now).state).toBe('met');
    expect(clocksFor(row(), now).map((c) => c.label)).toEqual(['Acknowledge by', 'Decide by']);
    expect(worstSla(row({ slaDecideBy: '2026-11-05T13:00:00.000Z' }), now)).toBe('breached');
    expect(worstSla(row({ ackedAt: 'x', decidedAt: 'y' }), now)).toBe('met');
  });

  it('severity first, then newest, then id: the order the server pages in', () => {
    const rows = [row({ id: 'a', severity: 'S3' }), row({ id: 'b', severity: 'S0', createdAt: '2026-11-05T13:00:00.000Z' }), row({ id: 'c', severity: 'S0' })];
    expect(queueOrder(rows).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});
