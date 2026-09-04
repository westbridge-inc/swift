import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  availableActions, clocksFor, worstSla, queueOrder,
  reasonProblem, reasonAccepted, evidenceActions,
  sosNeedsHuman, sosUrgency, INCIDENT_TRANSITIONS,
  type IncidentRow, type EvidenceBundleRow, type SosRow, type IncidentStatus,
} from './safetyView';

// ---------------------------------------------------------------------------
// The safety operations console.
//
// 23 routes shipped with no client: the whole incident lifecycle and the whole
// evidence chain of custody. These grade the rules the console applies BEFORE
// it calls the server — the state machine it mirrors, the SLA clocks it reads,
// and the chain-of-custody reason it refuses to let an operator skip.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-04T12:00:00.000Z');
const iso = (minsFromNow: number) => new Date(NOW.getTime() + minsFromNow * 60_000).toISOString();

const CASE = (over: Partial<IncidentRow> = {}): IncidentRow => ({
  id: 'c1', caseNumber: 'INC-AAAA1111', status: 'OPEN', severity: 'S1',
  category: 'SAFETY_ASSAULT', summary: 'x', subjectUserId: 'u1', orderId: null, sosAlertId: null,
  escalatedPoliceAt: null, legalHold: false, interimAction: 'NONE',
  slaAckBy: iso(60), slaDecideBy: iso(600), ackedAt: null, decidedAt: null, closedAt: null,
  decisionCode: null, createdAt: iso(-30), ...over,
});

describe('the console offers only what the server will accept', () => {
  it('mirrors the server state machine exactly', () => {
    // Restated in the console to grey out buttons. If the two ever disagree,
    // the console is either hiding a legal action or offering one that always
    // 409s — and an operator learns the console lies during an emergency.
    expect(INCIDENT_TRANSITIONS).toEqual({
      OPEN: ['TRIAGED'],
      TRIAGED: ['INVESTIGATING', 'DECIDED'],
      INVESTIGATING: ['DECIDED'],
      DECIDED: ['CLOSED'],
      CLOSED: [],
    });
  });

  it('offers ack only while the case is unacknowledged', () => {
    expect(availableActions(CASE())).toContain('ack');
    expect(availableActions(CASE({ ackedAt: iso(-5), status: 'TRIAGED' }))).not.toContain('ack');
  });

  it('a clear-cut case can be decided straight from triage, and never from OPEN', () => {
    // TRIAGED → DECIDED is a real edge in the server's machine; OPEN → DECIDED
    // is not, and offering it would be a button that always fails.
    expect(availableActions(CASE({ status: 'TRIAGED', ackedAt: iso(-1) }))).toContain('decide');
    expect(availableActions(CASE({ status: 'OPEN' }))).not.toContain('decide');
  });

  it('close is offered only after a decision', () => {
    expect(availableActions(CASE({ status: 'INVESTIGATING', ackedAt: iso(-1) }))).not.toContain('close');
    expect(availableActions(CASE({ status: 'DECIDED', ackedAt: iso(-1), decidedAt: iso(-1) }))).toContain('close');
  });

  it('a closed case offers nothing — including a police escalation the server refuses', () => {
    // escalatePolice throws CASE_CLOSED on a closed, never-escalated case.
    expect(availableActions(CASE({ status: 'CLOSED', closedAt: iso(-1), ackedAt: iso(-9), decidedAt: iso(-5) }))).toEqual([]);
  });

  it('police escalation is offered once, and interim action toggles', () => {
    expect(availableActions(CASE())).toContain('escalate-police');
    expect(availableActions(CASE({ escalatedPoliceAt: iso(-3) }))).not.toContain('escalate-police');

    expect(availableActions(CASE({ interimAction: 'NONE' }))).toContain('shadow-restrict');
    const restricted = availableActions(CASE({ interimAction: 'SHADOW_RESTRICTED' }));
    expect(restricted).toContain('lift-interim');
    expect(restricted).not.toContain('shadow-restrict');
  });
});

describe('SLA clocks read the deadline, never the status', () => {
  it('a case can sit in TRIAGED with its decide clock already blown', () => {
    const c = CASE({ status: 'TRIAGED', ackedAt: iso(-50), slaDecideBy: iso(-10) });
    const [ack, decide] = clocksFor(c, NOW);
    expect(ack!.state).toBe('met');       // stopped by ackedAt
    expect(decide!.state).toBe('breached');
    expect(worstSla(c, NOW)).toBe('breached');
  });

  it('a stopped clock never nags, even when it was stopped late', () => {
    // The deadline passed, but a human did the thing. Continuing to flash red
    // at work that is already done is how an operator learns to ignore red.
    const c = CASE({ ackedAt: iso(-1), slaAckBy: iso(-30), status: 'TRIAGED', decidedAt: iso(-1) });
    expect(clocksFor(c, NOW).every((k) => k.state === 'met')).toBe(true);
    expect(worstSla(c, NOW)).toBe('met');
  });

  it('warns at a fixed 15 minutes, not a percentage', () => {
    // An S0's whole ack window is five minutes. A percentage of that is not a
    // warning, it is a rounding error.
    expect(clocksFor(CASE({ slaAckBy: iso(10) }), NOW)[0]!.state).toBe('due');
    expect(clocksFor(CASE({ slaAckBy: iso(45) }), NOW)[0]!.state).toBe('ok');
  });

  it('orders the queue the way the server paginates it — severity first', () => {
    const rows = [CASE({ id: 'a', severity: 'S3' }), CASE({ id: 'b', severity: 'S0' }), CASE({ id: 'c', severity: 'S1' })];
    expect(queueOrder(rows).map((r) => r.severity)).toEqual(['S0', 'S1', 'S3']);
  });
});

describe('chain of custody: the reason is the audit trail', () => {
  it('accepts a real reason', () => {
    expect(reasonAccepted('Reviewing for the police request on case INC-4471')).toBe(true);
  });

  it('rejects what the server would accept but a court would not', () => {
    // Every access writes a SafetyAccessLog row that may be read back in an
    // investigation. The server only checks length (5–1000), so these all pass
    // it — and each one is a five-character confession that nobody was
    // supervising. The moment to catch it is before the row is written.
    for (const junk of ['asdfg', 'testing', 'check', 'xxxxx', '.....', 'aaaaaa', 'ababab']) {
      expect(reasonProblem(junk), `"${junk}" was accepted as a chain-of-custody reason`).not.toBeNull();
    }
  });

  it('still enforces the server\'s own bounds', () => {
    expect(reasonProblem('four')).toContain('5 characters');
    expect(reasonProblem('x'.repeat(1001))).toContain('1000');
  });
});

describe('evidence actions', () => {
  const B = (over: Partial<EvidenceBundleRow> = {}): EvidenceBundleRow => ({
    id: 'b1', bundleNumber: 'EV-AAAA1111', sosAlertId: null, caseId: 'c1', subjectUserId: 'u1',
    openedAt: iso(-60), sealedAt: null, sealHash: null, legalHold: false, _count: { items: 4 }, ...over,
  });

  it('seal is offered once — the database refuses a second one', () => {
    expect(evidenceActions(B())).toContain('seal');
    expect(evidenceActions(B({ sealedAt: iso(-1), sealHash: 'abc' }))).not.toContain('seal');
  });

  it('a sealed bundle can still be held and exported — that is the point of sealing', () => {
    const sealed = evidenceActions(B({ sealedAt: iso(-1), sealHash: 'abc' }));
    expect(sealed).toContain('export');
    expect(sealed).toContain('legal-hold');
    expect(sealed).toContain('view');
  });

  it('a hold already placed is not offered again', () => {
    expect(evidenceActions(B({ legalHold: true }))).not.toContain('legal-hold');
  });
});

describe('SOS: the coercion doctrine survives the queue', () => {
  const A = (over: Partial<SosRow> = {}): SosRow => ({
    id: 'a1', actorUserId: 'u1', actorRole: 'CUSTOMER', status: 'ACTIVE', orderId: null,
    triggeredAt: iso(-3), triggerSource: 'BUTTON', triggerLat: null, triggerLng: null,
    triggerAddressText: null, userSafeFlaggedAt: null, acknowledgedAt: null, retriggerCount: 0, ...over,
  });

  it('"I\'m safe" does not settle anything', () => {
    // The schema says it on the column: NEVER auto-resolves; a human must.
    // A queue's instinct is to dim a row that looks handled — that instinct is
    // exactly what a coerced tap is exploiting.
    const flagged = A({ userSafeFlaggedAt: iso(-1) });
    expect(sosNeedsHuman(flagged)).toBe(true);
    expect(sosUrgency(flagged, NOW)).toBe('critical');
  });

  it('only a real terminal state ends it', () => {
    expect(sosNeedsHuman(A({ status: 'RESOLVED' }))).toBe(false);
    expect(sosNeedsHuman(A({ status: 'CANCELLED' }))).toBe(false);
    expect(sosNeedsHuman(A({ status: 'ACKNOWLEDGED' }))).toBe(true);
  });

  it('a repeat trigger is always critical — asking twice is not less urgent', () => {
    expect(sosUrgency(A({ status: 'ACKNOWLEDGED', acknowledgedAt: iso(-1), retriggerCount: 3 }), NOW)).toBe('critical');
  });

  it('an unacknowledged ACTIVE alert outranks everything', () => {
    expect(sosUrgency(A(), NOW)).toBe('critical');
    expect(sosUrgency(A({ status: 'TRIGGER_PENDING' }), NOW)).toBe('high');
  });
});

describe('every status is covered', () => {
  it('availableActions handles all five statuses without throwing', () => {
    const statuses: IncidentStatus[] = ['OPEN', 'TRIAGED', 'INVESTIGATING', 'DECIDED', 'CLOSED'];
    for (const status of statuses) {
      expect(() => availableActions(CASE({ status }))).not.toThrow();
    }
  });
});

describe('raising a case by hand', () => {
  const D = (over: Partial<import('./safetyView').IntakeDraft> = {}) => ({
    subjectUserId: 'u1', category: 'SAFETY_ASSAULT', severity: '' as const, summary: 'They were hit.', orderId: '', ...over,
  });

  it('will not open a case with no subject, no category or an empty story', async () => {
    const { intakeProblem } = await import('./safetyView');
    expect(intakeProblem(D({ subjectUserId: '  ' }))).toMatch(/who/i);
    expect(intakeProblem(D({ category: '' }))).toMatch(/category/i);
    expect(intakeProblem(D({ summary: 'x' }))).toMatch(/5 characters/);
    expect(intakeProblem(D())).toBeNull();
  });

  it('shows the SLA the operator is committing to', async () => {
    // Picking the category is what starts the clock. An S0 is a five-minute
    // acknowledgement window, and an operator on a phone call should see that
    // before they press the button, not after.
    const { defaultSeverityFor } = await import('./safetyView');
    expect(defaultSeverityFor('SAFETY_ASSAULT')).toBe('S0');
    expect(defaultSeverityFor('SERVICE_QUALITY')).toBe('S4');
    expect(defaultSeverityFor('SOMETHING_UNKNOWN')).toBe('S3');
  });
});

describe('census drift vs the API', () => {
  // The categories and their default severities are a CROSS-APP contract:
  // the server decides the SLA, the console has to offer the category. A
  // category the console cannot express is a case filed as OTHER, which is an
  // S3 — so an assault reported by phone would silently get a ten-day clock.
  //
  // Read from the API source rather than restated, for the same reason the
  // mobile notification census does: a hand-copied list drifts silently.
  const API_SRC = join(process.cwd(), '../api/src/modules/safety/incident.service.ts');

  it('can read the API source it is meant to check', () => {
    // UNVERIFIED beats a fake PASS.
    expect(existsSync(API_SRC), `${API_SRC} not found — the drift check cannot run`).toBe(true);
  });

  it('offers every category the server knows, at the severity the server assigns', async () => {
    if (!existsSync(API_SRC)) return;
    const src = readFileSync(API_SRC, 'utf8');
    const block = src.slice(src.indexOf('CATEGORY_SEVERITY'));
    const body = block.slice(block.indexOf('{') + 1, block.indexOf('}'));
    const server = [...body.matchAll(/([A-Z_]+):\s*'(S[0-4])'/g)].map((m) => ({ code: m[1]!, severity: m[2]! }));
    expect(server.length, 'no categories parsed from the API source').toBeGreaterThan(5);

    const { INCIDENT_CATEGORIES } = await import('./safetyView');
    expect(INCIDENT_CATEGORIES).toEqual(server);
  });
});
