import { describe, expect, it } from 'vitest';
import * as labels from './review-center';
describe('review copy', () => {
  it('uses one human label vocabulary for document, role and vehicle facts', () => {
    expect(labels.docLabel('owner_national_id')).toBe('National ID');
    expect(labels.docLabel('gra_restaurant_licence')).toBe('GRA restaurant licence');
    expect(labels.docLabel('drivers_licence')).toBe("Driver's licence");
    expect(labels.roleLabel('VENDOR_OWNER')).toBe('Business owner');
    expect(labels.roleLabel('MOVER')).toBe('Rider/Driver');
    expect(labels.vehicleLabel('CAR')).toBe('Car');
  });
  it('distinguishes failed and partial document reading from successful reading', () => {
    expect(labels.timelineLabel('EXTRACTED FAILED (NO_FIELDS)')).toBe('Document reading failed');
    expect(labels.timelineLabel('EXTRACTED PARTIAL')).toBe('Document reading partially completed');
    expect(labels.timelineLabel('EXTRACTED OK')).toBe('Document reading completed');
    expect(labels.timelineLabel('V_PLATE_CLASS WARN [blocking]')).toBe('Plate class check: needs attention — blocking');
    expect(labels.timelineLabel('DECIDED REQUEST_INFO')).toBe('More information requested');
  });
  it('never falls back to raw unknown timeline data', () => {
    expect(labels.timelineLabel('NEW_ACTION /api/internal secret-id')).toBe('Document activity recorded');
    expect(labels.timelineLabel('DECIDED REJECTED under UNREADABLE')).toBe('Rejected: Too blurry or dark to read');
    expect(labels.timelineLabel('V_PLATE_CLASS PASS [blocking]')).toBe('Plate class check: passed — blocking');
  });
});
